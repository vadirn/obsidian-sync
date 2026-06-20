# syntax=docker/dockerfile:1
# Official Obsidian Sync headless client (binary `ob`). No Electron/Chromium/Xvfb:
# the only native dep is better-sqlite3, prebuilt for linux on the node:22 base.
FROM node:22-slim

# Pin the open-beta version; flags can change between releases.
RUN npm install -g obsidian-headless@0.0.12

# Client config (auth_token, config.json, sqlite state) persists under here;
# mount a volume at /config so login survives container restarts.
ENV XDG_CONFIG_HOME=/config
WORKDIR /vault

# Pull-only mirror so the box never pushes to the real vault. The mirror-remote
# mode is set once by `ob sync-config --mode mirror-remote` and persisted in the
# /config volume; `ob sync` itself takes no --mode flag. First-time setup
# (ob login / ob sync-setup / ob sync-config) is a one-time `docker compose run`
# step (see DEPLOY.md).
CMD ["sh", "-c", "ob sync --continuous"]
