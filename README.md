# Obsidian Sync + Wireguard VPN

Self-hosted livesync + VPN on Vultr VPS using Docker + Caddy.

## Stack

- **CouchDB 3.3** - Database backend for livesync
- **Caddy** - Reverse proxy with auto SSL/TLS
- **Wireguard** - VPN for secure access

## Quick Start

### Prerequisites

- Vultr account (or any VPS provider)
- Domain name (optional for VPN-only setup)
- ~$12/mo budget (4GB RAM, 80GB SSD recommended)

### 1. VPS Setup on Vultr

**Deploy instance:**
1. Login to Vultr → Deploy New Server
2. Select: Ubuntu 22.04 LTS, Cloud Compute, 4GB RAM / 80GB SSD
3. Add SSH key
4. Note the IP address

**SSH in:**
```bash
ssh root@YOUR_VPS_IP
```

**Install Docker:**
```bash
apt update && apt upgrade -y
apt install -y docker.io docker-compose git
systemctl start docker && systemctl enable docker
```

**Firewall:**
```bash
ufw enable
ufw allow 22/tcp 80/tcp 443/tcp 51820/udp
ufw status
```

### 2. Deploy on VPS

**Clone/upload project:**
```bash
cd /opt
git clone <your-repo-url> obsidian-sync
cd obsidian-sync
```

**Create `.env`** (copy from `.env.example`, update values):
```bash
cp .env.example .env
```

Edit `.env`:
```
COUCHDB_USER=admin
COUCHDB_PASSWORD=<strong-password>
VPS_DOMAIN=your-domain.com  # or keep as 'localhost' if no domain
VPS_IP=<your-vps-ip>
WIREGUARD_PEERS=3
TZ=UTC
```

**If using domain with Caddy (HTTPS):**
1. Point DNS: `your-domain.com` → VPS_IP
2. Wait for DNS propagation (5-60 min)
3. Update Caddyfile or it will auto-update from VPS_DOMAIN env var

**Start services:**
```bash
docker-compose up -d
docker-compose ps
```

**Verify:**
```bash
curl http://localhost:5984  # CouchDB direct
curl https://your-domain.com  # Via Caddy (if domain set)
```

### 3. CouchDB Initialization

After first startup, initialize CouchDB:
```bash
docker exec obsidian-couchdb curl -s https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/utils/couchdb/couchdb-init.sh | bash
```

Or manually via web interface (admin credentials from `.env`):
```
http://your-vps-ip:5984/_utils/
```

### 4. Obsidian Client Setup

**Install plugin:**
1. Obsidian → Settings → Community Plugins → Browse
2. Search "Self-hosted LiveSync" (by vrtmrz)
3. Install & enable

**Configure:**
1. Settings → Self-hosted LiveSync
2. Server URL: `https://your-domain.com` or `http://your-vps-ip:5984`
3. Username: `admin`
4. Password: (from `.env` COUCHDB_PASSWORD)
5. Test connection

**Sync:**
- Desktop: Just configure the plugin
- Mobile: May require VPN access or HTTPS (hence Caddy)

### 5. Wireguard Client Setup (Optional)

Get peer config from server:
```bash
docker exec wireguard cat /config/peer1/peer1.conf
```

On client device:
1. Install Wireguard app
2. Create new tunnel, paste config content
3. Activate VPN
4. Access CouchDB at `http://10.13.13.1:5984` or `https://your-domain.com`

## File Structure

```
.
├── Dockerfile           # CouchDB + Wireguard tools
├── docker-compose.yml   # Service orchestration
├── Caddyfile           # Reverse proxy config
├── .env                # Secrets (don't commit)
├── .env.example        # Template
├── livesync/config/    # CouchDB data persistence
└── wireguard/config/   # VPN configs & certs
```

## Troubleshooting

| Issue | Solution |
|-------|----------|
| "Connection refused" | Check `docker-compose ps`, firewall rules |
| Caddy cert fails | Verify domain DNS resolves to VPS IP |
| Wireguard won't connect | Check `docker logs wireguard`, peer config |
| CouchDB 404 on /_utils | Normal if not initialized, use livesync plugin instead |

## Maintenance

```bash
# View logs
docker-compose logs -f couchdb
docker-compose logs -f caddy
docker-compose logs -f wireguard

# Stop services
docker-compose down

# Restart
docker-compose up -d

# Update images
docker-compose pull
docker-compose up -d
```

## Ports

| Service | Port | Protocol | Purpose |
|---------|------|----------|---------|
| Caddy | 80 | TCP | HTTP (redirects to 443) |
| Caddy | 443 | TCP | HTTPS reverse proxy |
| CouchDB | 5984 | TCP | Direct access (internal) |
| Wireguard | 51820 | UDP | VPN tunnel |

## Security Notes

- Never commit `.env` with real credentials
- Use strong CouchDB password (20+ chars, mixed case)
- Rotate Wireguard keys periodically
- Keep Docker images updated: `docker-compose pull`
- Consider fail2ban on VPS for SSH brute-force protection

## Storage Tier Options

- **2GB / 50GB**: $6/mo (small vault <5GB)
- **4GB / 80GB**: $12/mo (recommended for most)
- **8GB / 160GB**: $24/mo (large vault growth)

Can upgrade Vultr instance anytime without downtime.

## References

- [Obsidian LiveSync Docs](https://github.com/vrtmrz/obsidian-livesync)
- [CouchDB Admin](http://your-vps-ip:5984/_utils/)
- [Caddy Docs](https://caddyserver.com/docs/)
- [Wireguard](https://www.wireguard.com/)
