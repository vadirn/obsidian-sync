# Obsidian vault access on a VPS

A Vultr VPS that runs three things behind Docker:

1. **WireGuard**: a personal VPN (the original reason for the box).
2. **obsidian-headless**: official Obsidian Sync in headless mode, pulling the
   vault down as plaintext `.md` files into a shared volume.
3. **consult MCP server**: a read-only HTTP MCP endpoint that exposes
   `vault-query consult` over the synced vault, fronted by Caddy with auto TLS.

The legacy self-hosted LiveSync/CouchDB stack was removed. Sync now runs through
the official Obsidian Sync service; the MCP server reads the mirrored files.

## Stack

| Service             | Image / build                      | Role                                                  |
| ------------------- | ---------------------------------- | ----------------------------------------------------- |
| `wireguard`         | `linuxserver/wireguard`            | Personal VPN. Independent of the vault services.      |
| `caddy`             | `caddy:latest`                     | Reverse proxy, auto SSL/TLS, serves `{$MCP_DOMAIN}`.  |
| `obsidian-headless` | `mcp/obsidian-headless.Dockerfile` | Pull-only Obsidian Sync → `vault_data` volume.        |
| `mcp`               | `mcp/Dockerfile`                   | Read-only consult MCP server (`vault-query` + synth). |

Volumes: `wireguard_config`, `caddy_data`, `vault_data` (the mirrored vault),
`obsidian_config` (the headless Sync account state).

## Quick start

### Prerequisites

- Vultr account (or any VPS provider).
- A domain, for the MCP route and its TLS certificate.
- An active paid Obsidian Sync subscription (a dedicated account is recommended;
  the stored token is account-scoped).

### 1. VPS setup

Deploy Ubuntu 22.04 LTS (2GB RAM is enough; 4GB if the vault is large), add an
SSH key, note the IP.

```bash
ssh root@YOUR_VPS_IP
apt update && apt upgrade -y
apt install -y docker.io docker-compose git
systemctl start docker && systemctl enable docker
```

Firewall (no CouchDB port any more):

```bash
ufw enable
ufw allow 22/tcp 80/tcp 443/tcp 51820/udp
ufw status
```

### 2. Clone and configure

```bash
cd /opt
git clone <your-repo-url> obsidian-sync
cd obsidian-sync
```

Put the non-secrets in a gitignored `.env` at the repo root:

```
MCP_DOMAIN=mcp.your-domain.com
MCP_RESOURCE_URL=https://mcp.your-domain.com/mcp
VPS_IP=<your-vps-ip>
WIREGUARD_PEERS=3
TZ=UTC
```

Secrets (`FIREWORKS_API_KEY`, `OBSIDIAN_AUTH_TOKEN`, `MCP_BEARER_TOKEN`) go
through Doppler or a separate `.env`. The deploy detail lives in
[`mcp/DEPLOY.md`](mcp/DEPLOY.md).

### 3. Bring up the services

Point DNS `mcp.your-domain.com` → `VPS_IP`, then:

```bash
docker compose up -d wireguard          # the VPN, independent of the vault
docker compose run --rm obsidian-headless ob login   # one-time Sync login
docker compose up -d obsidian-headless  # starts the pull-only mirror
docker compose up -d mcp caddy          # MCP server + reverse proxy with TLS
docker compose ps
```

Caddy auto-provisions a certificate on the first request to `MCP_DOMAIN`. The
full one-time Obsidian Sync setup (`ob sync-setup`, `ob sync-config`) and the
Claude connector registration are in [`mcp/DEPLOY.md`](mcp/DEPLOY.md).

### 4. WireGuard client setup

Get a peer config from the server:

```bash
docker exec wireguard cat /config/peer1/peer1.conf
```

On the client device: install the WireGuard app, create a tunnel from the config,
activate it.

## Ports

| Service   | Port  | Protocol | Purpose                           |
| --------- | ----- | -------- | --------------------------------- |
| Caddy     | 80    | TCP      | HTTP, redirects to 443            |
| Caddy     | 443   | TCP      | HTTPS reverse proxy to `mcp:3000` |
| WireGuard | 51820 | UDP      | VPN tunnel                        |

The `mcp` and `obsidian-headless` services publish no host ports. Caddy reaches
`mcp` on the compose network as `mcp:3000`.

## Maintenance

```bash
docker compose logs -f mcp
docker compose logs -f obsidian-headless
docker compose logs -f caddy
docker compose logs -f wireguard

docker compose pull        # update images
docker compose up -d
docker compose down        # stop everything
```

## Security notes

- Never commit `.env` with real credentials.
- The `OBSIDIAN_AUTH_TOKEN` is account-scoped: use a dedicated Obsidian account
  invited only to the target vault.
- The `vault_data` mount is read-only for the `mcp` service; it never writes the
  vault.
- Rotate WireGuard keys periodically. Consider fail2ban for SSH.
- Keep Docker images updated.

## References

- [Obsidian Sync](https://obsidian.md/sync)
- [Caddy Docs](https://caddyserver.com/docs/)
- [WireGuard](https://www.wireguard.com/)
- Consult MCP server operations: [`mcp/DEPLOY.md`](mcp/DEPLOY.md)
