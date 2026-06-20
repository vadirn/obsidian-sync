# consult MCP server: operations & deploy

A read-only remote MCP server that exposes the user's `vault-query consult` over
Streamable HTTP, with server-side query-scoped synthesis via Fireworks (GLM 5.2).
Additive to the existing `obsidian-sync` stack. It does not touch the `wireguard`
service, its volume, or `WIREGUARD_PEERS`.

## Architecture

```
Obsidian Sync (cloud, E2EE)
      │  ob sync --continuous --mode mirror-remote   (pull-only)
      ▼
obsidian-headless container ──writes .md──▶ vault_data volume ──:ro──▶ mcp container
                                                                          │ vault-query --vault-root /vault
Claude ──HTTPS 443──▶ Caddy ──reverse_proxy──▶ mcp:3000 ───────────────────┘
                                                  │ consult (exit 0) → drill pointers via read
                                                  │ consult (exit 4) → abstained:true
                                                  └ Fireworks GLM → synthesis
```

Tool response: `{ synthesis, slices: [{path, address, excerpt}], abstained, reason?, note? }`.
`synthesis` is populated when `FIREWORKS_API_KEY` is set; otherwise `null` (slices still returned).

## Environment variables

Two layers compose cleanly. `docker compose` resolves each `${VAR:-}` from the
process environment; a `doppler run --` wrapper injects secrets into that
environment at runtime, so no plaintext key sits on disk. Doppler-injected vars
override `.env` for the same name. Keep non-secrets in the repo-root `.env`
(gitignored, auto-loaded); inject secrets with Doppler.

The harness blocks edits to `.env.example`, so this is the authoritative list.

### Secrets: Doppler (`claude-code` project, `std` config)

Run anything that needs a secret under `doppler run`:

```bash
doppler run -p claude-code -c std -- docker compose up -d
# server, locally:
doppler run -p claude-code -c std -- node dist/server.js
```

| Key                   | Provisioned in `std`?  | Purpose                                                                                                                                             |
| --------------------- | ---------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FIREWORKS_API_KEY`   | yes                    | empty disables synthesis (returns `synthesis:null`)                                                                                                 |
| `OBSIDIAN_AUTH_TOKEN` | no, `ob login` instead | only if injecting a token directly; `ob login` writes to the `obsidian_config` volume instead                                                       |
| `MCP_BEARER_TOKEN`    | no, add or use `.env`  | static token; works in `bearer` mode and as an escape hatch in `oauth` mode. Generate: `openssl rand -hex 32`                                       |
| `MCP_AUTH_PASSWORD`   | no, add or use `.env`  | HTTP Basic password gating `/authorize` in `oauth` mode (the one human gate). Required when `MCP_AUTH_MODE=oauth`. Generate: `openssl rand -hex 12` |

Only `FIREWORKS_API_KEY` lives in Doppler today. Add the others before relying on
the `doppler run` model for them: `doppler secrets set OBSIDIAN_AUTH_TOKEN -p claude-code -c std`
(interactive prompt, no value on the command line). Until then they fall back to
`.env`. The box uses neither Doppler nor `.env` for the three server secrets: it
mounts them as files via Compose secrets (next section).

### Secrets on the box: Compose secret files (`docker-compose.secrets.yml`)

The box has no Doppler, and injecting secrets through `--env-file stack.conf` leaks
them into the container environment (`docker inspect`, `/proc/<pid>/environ`, the
spawned `vault-query` child). Instead the box overlays `docker-compose.secrets.yml`,
which mounts each secret as a file at `/run/secrets/<name>` (mode 0444, readable by
the non-root `node` user) from a host source under `secrets/` kept `600` root-owned.

The server resolves each secret via `src/secrets.ts` (`resolveSecret`): it prefers
the inline env var when non-empty, else reads `<NAME>_FILE`. So an empty
`MCP_BEARER_TOKEN` in `stack.conf` makes it fall through to the mounted file.

| Host file (`secrets/`, `chmod 600`) | Mounted at                       | Resolved env var    |
| ----------------------------------- | -------------------------------- | ------------------- |
| `secrets/mcp_bearer_token`          | `/run/secrets/mcp_bearer_token`  | `MCP_BEARER_TOKEN`  |
| `secrets/mcp_auth_password`         | `/run/secrets/mcp_auth_password` | `MCP_AUTH_PASSWORD` |
| `secrets/fireworks_api_key`         | `/run/secrets/fireworks_api_key` | `FIREWORKS_API_KEY` |

One-time on the box, before the deploy below:

```bash
mkdir -p /root/obsidian-sync/secrets && chmod 700 /root/obsidian-sync/secrets
printf '%s' '<token>'    > /root/obsidian-sync/secrets/mcp_bearer_token
printf '%s' '<password>' > /root/obsidian-sync/secrets/mcp_auth_password
printf '%s' '<fw-key>'   > /root/obsidian-sync/secrets/fireworks_api_key
chmod 600 /root/obsidian-sync/secrets/*
# Remove these three keys from stack.conf so they no longer land in the env;
# leave the non-secret vars. An unset var resolves empty → the file is used.
```

`secrets/` is gitignored and excluded from the rsync deploy, so the values live
only on the box. Local dev skips this overlay (secrets come from Doppler / the
override), so it needs no `secrets/` files. At-rest encryption (sops/age) was
declined: the box must auto-restart secrets on reboot, so the decryption key would
have to live on the same disk, giving no real gain over `600` perms against the
realistic threats (root compromise, full-disk snapshot).

### Non-secrets: `.env`

| Key                    | Default                             | Purpose                                                                               |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `MCP_AUTH_MODE`        | `bearer`                            | `none` (local only) \| `bearer` (static token) \| `oauth` (self-hosted AS, see below) |
| `MCP_RESOURCE_URL`     | `https://mcp.localhost/mcp`         | public MCP endpoint (OAuth token audience)                                            |
| `MCP_OAUTH_ISSUER`     | origin of `MCP_RESOURCE_URL`        | OAuth AS issuer (`oauth` mode only)                                                   |
| `OAUTH_STORE`          | `/data/oauth.json`                  | path to the persisted OAuth state (clients + tokens); mount `oauth_data` here         |
| `MCP_DOMAIN`           | `mcp.localhost`                     | subdomain Caddy serves the MCP route on                                               |
| `FIREWORKS_MODEL`      | `accounts/fireworks/models/glm-5p2` | Fireworks model id                                                                    |
| `FIREWORKS_MAX_TOKENS` | `1024`                              | synthesis output cap                                                                  |
| `MCP_RATE_LIMIT`       | `30`                                | per-IP token bucket on `/mcp`, requests/min (429 past the cap)                        |
| `MCP_MAX_CONCURRENCY`  | `2`                                 | global cap on simultaneous `consult` index builds (busy error past the cap)           |

## Local testing (macOS, docker compose)

The MCP server is exercised without real Obsidian Sync credentials by mounting a
stub vault and skipping the obsidian-headless sidecar.

> If `docker compose build` hangs at `error getting credentials` (the `credsStore`
> helper, e.g. `osxkeychain`, blocks during `FROM` image resolution), either drop
> `credsStore` from `~/.docker/config.json` so public bases pull anonymously, or use the
> registry-free `mcp/Dockerfile.localtest`, which builds from a locally-cached
> devcontainer base and installs Rust via rustup:
> `docker build -f mcp/Dockerfile.localtest -t obsidian-mcp:localtest mcp`.
> This is a local workaround only: deploy uses `mcp/Dockerfile`.

```bash
# 1. Vendor the vault-query Rust source into the build context (Docker can't reach
#    a tree outside ./mcp). Override source with VAULT_QUERY_SRC if not ~/nix/vault-query.
bash mcp/vendor-vault-query.sh

# 2. Build the image (multi-stage: cargo build of vault-query + the TS server).
docker compose build mcp

# 3. A throwaway override: stub vault, auth off, no sidecar dependency.
cat > docker-compose.override.yml <<'EOF'
services:
  mcp:
    environment:
      - MCP_AUTH_MODE=none
      - MCP_RESOURCE_URL=http://mcp.localhost:3000/mcp
    ports:
      - "3000:3000"
    volumes:
      - /tmp/stub-vault:/vault:ro
    depends_on: []
EOF

# 4. Run and exercise it with the SDK test client (talks Streamable HTTP like Claude).
docker compose up -d mcp
cd mcp && node test-client.mjs "caching strategy" "xqzptvwmlbrfk gibberish"

# 5. Tear down; remove the override before any deploy.
docker compose down && rm docker-compose.override.yml
```

To test synthesis locally, wrap the bring-up in `doppler run` so the Fireworks key
is injected (never written to disk or the override):

```bash
doppler run -p claude-code -c std -- docker compose up -d mcp
```

`synthesis` then comes back populated. The host-only path (no container) is
`doppler run -p claude-code -c std -- env MCP_AUTH_MODE=none VAULT_ROOT=/tmp/stub-vault PORT=3000 node dist/server.js`.

## Deploy to the Vultr box (95.179.177.220)

All steps are additive; `wireguard` keeps running throughout.

1. **DNS**: `A` record `mcp.<yourdomain>` → `95.179.177.220`. Caddy auto-provisions TLS
   on first request (80/443 already mapped). In `.env` on the box set the non-secrets:

   ```
   MCP_DOMAIN=mcp.<yourdomain>
   MCP_RESOURCE_URL=https://mcp.<yourdomain>/mcp
   ```

   Provide secrets via Doppler rather than `.env`. Install the Doppler CLI on the box
   and configure a service token scoped to `claude-code`/`std`
   (`doppler configure set token <service-token> --scope /path/to/repo`), then prefix
   every `docker compose` invocation below with `doppler run -p claude-code -c std --`.
   Fallback without Doppler on the box: put `FIREWORKS_API_KEY` (and the other three
   secrets) in `.env` instead.

2. **Vendor vault-query on the box** (the source must be reachable):
   `VAULT_QUERY_SRC=/path/to/nix/vault-query bash mcp/vendor-vault-query.sh`, or copy a
   prebuilt Linux binary into the image (faster: replace stage 1 of `mcp/Dockerfile`
   with a `COPY` of the binary).

3. **Dedicated Obsidian account** (decided at deploy, see "Sync account" below). One-time:

   ```bash
   docker compose run --rm obsidian-headless ob login
   docker compose run --rm obsidian-headless ob sync-list-remote
   docker compose run --rm -w /vault obsidian-headless ob sync-setup --vault "<Vault Name>"
   docker compose run --rm obsidian-headless ob sync-config --mode mirror-remote
   ```

   Requires an **active paid Obsidian Sync subscription**. The token is account-scoped;
   prefer a dedicated account invited only to the target vault.

4. **Bring up only the additive services** (wireguard untouched). On the box every
   `docker compose` call takes `--env-file stack.conf` (the stale `.env` holds dead
   couchdb vars) and the secrets overlay so the `mcp` service gets its mounted
   secret files:

   ```bash
   C="docker compose --env-file stack.conf -f docker-compose.yml -f docker-compose.secrets.yml"
   $C build mcp
   $C up -d obsidian-headless
   $C up -d mcp
   $C up -d caddy                        # picks up the new route + MCP_DOMAIN
   $C ps                                 # confirm wireguard stayed Up
   ```

   Verify the WireGuard tunnel from a peer before and after.

5. **Auth: `oauth` mode.** claude.ai's custom-connector flow drives OAuth discovery +
   Dynamic Client Registration + PKCE; it does **not** accept a static bearer (confirmed).
   The server self-hosts a minimal OAuth 2.1 AS (`src/oauth.ts` + the SDK `mcpAuthRouter`
   wired in `src/server.ts`):
   - Set `MCP_AUTH_MODE=oauth` and `MCP_AUTH_PASSWORD` (the server refuses to start in
     `oauth` mode without it). The AS endpoints are served at the issuer origin:
     `/.well-known/oauth-authorization-server`, `/authorize`, `/token`, `/register`,
     `/revoke`, and the path-specific `/.well-known/oauth-protected-resource/mcp`.
   - DCR auto-registers any client (public, PKCE-only); no `client_id`/`client_secret`
     to enter. Clients + tokens persist to `OAUTH_STORE` on the `oauth_data` volume.
   - The only human gate is `/authorize`, protected by HTTP Basic against
     `MCP_AUTH_PASSWORD` (any username). `verifyAccessToken` binds tokens to
     `MCP_RESOURCE_URL`; `MCP_BEARER_TOKEN`, if set, still works as a CLI/test escape hatch.
   - Smoke-test discovery: `curl https://<domain>/.well-known/oauth-authorization-server`,
     and `curl -D- https://<domain>/mcp` should return `401` with a `Bearer ...
resource_metadata=...` challenge.

6. **Register in claude.ai**: Settings → Connectors → Add custom connector →
   `https://<domain>/mcp` (leave client id/secret blank) → on the browser consent step a
   Basic-auth prompt (realm "consult vault") asks for `MCP_AUTH_PASSWORD`. Claude reaches
   the box from Anthropic's cloud, so the route must be publicly reachable on 443 (it is,
   via Caddy). Team/Enterprise: an Owner enables custom connectors org-wide first.

## Open items

- **Sync account**: currently the personal Obsidian account (full-account blast radius if
  the box is compromised). Dedicated account is safer (9/10); revisit if hardening further.
- **Security hardening** (P0, outside this repo): the legacy `obsidian-couchdb` is still
  published on `:5984` (Docker bypasses ufw) — remove it. SSH allows root + password login
  with no fail2ban — switch to key-only and add fail2ban.
- **Rate / resource limits** (P1, done): `/mcp` now has a per-IP token bucket
  (`MCP_RATE_LIMIT`, 429 past the cap) ahead of auth plus a global semaphore on
  simultaneous `consult` index builds (`MCP_MAX_CONCURRENCY`, busy error past the cap),
  both in `src/limits.ts`; `mem_limit: 1g` / `cpus: 1.0` cap the `mcp` container so a
  flood throttles instead of OOM-killing the box. `app.set("trust proxy", 1)` makes the
  bucket key on the real client IP from Caddy's `X-Forwarded-For`.
- **vault-query latency**: consult rebuilds an in-memory index per call (no daemon).
  Add an MCP-layer cache keyed on (query, vault mtime) if p95 latency hurts.
- **obsidian-headless** is open beta (v0.0.12); pinned in the image, re-test on bumps.
  Never run desktop Sync and headless Sync on the same vault at once.
