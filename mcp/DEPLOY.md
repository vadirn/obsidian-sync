# consult MCP server — operations & deploy

A read-only remote MCP server that exposes the user's `vault-query consult` over
Streamable HTTP, with server-side query-scoped synthesis via Fireworks (GLM 5.2).
Additive to the existing `obsidian-sync` stack — it does not touch the `wireguard`
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

### Secrets — Doppler (`claude-code` project, `std` config)

Run anything that needs a secret under `doppler run`:

```bash
doppler run -p claude-code -c std -- docker compose up -d
# server, locally:
doppler run -p claude-code -c std -- node dist/server.js
```

| Key                   | Provisioned in `std`?  | Purpose                                                          |
| --------------------- | ---------------------- | ---------------------------------------------------------------- |
| `FIREWORKS_API_KEY`   | yes                    | empty disables synthesis (returns `synthesis:null`)              |
| `OBSIDIAN_AUTH_TOKEN` | no — add or use `.env` | dedicated Obsidian account token (account-scoped — keep secret)  |
| `MCP_BEARER_TOKEN`    | no — add or use `.env` | static token for `bearer` mode. Generate: `openssl rand -hex 32` |

Only `FIREWORKS_API_KEY` lives in Doppler today. Add the others before relying on
the `doppler run` model for them: `doppler secrets set OBSIDIAN_AUTH_TOKEN -p claude-code -c std`
(interactive prompt, no value on the command line). Until then they fall back to
`.env`. `FIREWORKS_API_KEY_FILE` (path to a file holding the key, Docker-secret
style) remains a third option, unused under the `doppler run` model.

### Non-secrets — `.env`

| Key                    | Default                             | Purpose                                                                       |
| ---------------------- | ----------------------------------- | ----------------------------------------------------------------------------- |
| `MCP_AUTH_MODE`        | `bearer`                            | `none` (local only) \| `bearer` (static token) \| `oauth` (deploy, see below) |
| `MCP_RESOURCE_URL`     | `https://mcp.localhost/mcp`         | public MCP endpoint (OAuth token audience)                                    |
| `MCP_OAUTH_ISSUER`     | origin of `MCP_RESOURCE_URL`        | OAuth AS issuer (`oauth` mode only)                                           |
| `MCP_DOMAIN`           | `mcp.localhost`                     | subdomain Caddy serves the MCP route on                                       |
| `FIREWORKS_MODEL`      | `accounts/fireworks/models/glm-5p2` | Fireworks model id                                                            |
| `FIREWORKS_MAX_TOKENS` | `1024`                              | synthesis output cap                                                          |

## Local testing (macOS, docker compose)

The MCP server is exercised without real Obsidian Sync credentials by mounting a
stub vault and skipping the obsidian-headless sidecar.

> If `docker compose build` hangs at `error getting credentials` (the `credsStore`
> helper — e.g. `osxkeychain` — blocks during `FROM` image resolution), either drop
> `credsStore` from `~/.docker/config.json` so public bases pull anonymously, or use the
> registry-free `mcp/Dockerfile.localtest`, which builds from a locally-cached
> devcontainer base and installs Rust via rustup:
> `docker build -f mcp/Dockerfile.localtest -t obsidian-mcp:localtest mcp`.
> This is a local workaround only — deploy uses `mcp/Dockerfile`.

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
   prebuilt Linux binary into the image (faster — replace stage 1 of `mcp/Dockerfile`
   with a `COPY` of the binary).

3. **Dedicated Obsidian account** (decided at deploy — see "Sync account" below). One-time:

   ```bash
   docker compose run --rm obsidian-headless ob login
   docker compose run --rm obsidian-headless ob sync-list-remote
   docker compose run --rm -w /vault obsidian-headless ob sync-setup --vault "<Vault Name>"
   docker compose run --rm obsidian-headless ob sync-config --mode mirror-remote
   ```

   Requires an **active paid Obsidian Sync subscription**. The token is account-scoped;
   prefer a dedicated account invited only to the target vault.

4. **Bring up only the additive services** (wireguard untouched):

   ```bash
   docker compose up -d obsidian-headless
   docker compose up -d mcp
   docker compose up -d caddy            # picks up the new route + MCP_DOMAIN
   docker compose ps                     # confirm wireguard stayed Up
   ```

   Verify the WireGuard tunnel from a peer before and after.

5. **Auth before registering the connector**: Claude's custom-connector flow drives an
   OAuth discovery + PKCE handshake; a static bearer token is likely **not** accepted by
   the standard "Add custom connector" path (confidence 7/10 — verify on your tier first).
   - First verify: try `MCP_AUTH_MODE=bearer` and adding the connector with the token in
     Claude's Advanced settings.
   - If rejected, switch to `MCP_AUTH_MODE=oauth` and finish the OAuth path in
     `src/server.ts` (mount the SDK `mcpAuthRouter` to self-host a minimal OAuth 2.1 AS,
     and replace the `oauth` branch in `authGuard` with `requireBearerAuth` validating
     `aud === MCP_RESOURCE_URL`). The PRM endpoint (`/.well-known/oauth-protected-resource`)
     is already served.

6. **Register in Claude**: Settings → Connectors → Add custom connector →
   `https://mcp.<yourdomain>/mcp` → complete OAuth consent. Claude reaches the box from
   Anthropic's cloud, so the route must be publicly reachable on 443 (it is, via Caddy).
   Team/Enterprise: an Owner enables custom connectors org-wide first.

## Open items

- **Sync account** (deferred): dedicated paid Obsidian account vs personal. Dedicated
  recommended (9/10) — the stored token is account-scoped (full-account blast radius).
- **OAuth vs bearer**: verify what Claude's connector flow accepts before building the
  full OAuth path (step 5).
- **vault-query latency**: consult rebuilds an in-memory index per call (no daemon).
  Add an MCP-layer cache keyed on (query, vault mtime) if p95 latency hurts.
- **obsidian-headless** is open beta (v0.0.12); pinned in the image — re-test on bumps.
  Never run desktop Sync and headless Sync on the same vault at once.
