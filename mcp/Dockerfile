# syntax=docker/dockerfile:1
# Build context is ./mcp (see docker-compose.yml). The vault-query Rust source is
# vendored into ./mcp/.vault-query-src by vendor-vault-query.sh before building,
# because Docker COPY cannot reach a source tree outside the build context.

# --- Stage 1: build vault-query from source (Cargo edition 2024 needs Rust >= 1.85) ---
FROM rust:1.85-bookworm AS vqbuild
WORKDIR /src
COPY .vault-query-src/ ./
RUN cargo build --release --locked && cp target/release/vault-query /usr/local/bin/vault-query

# --- Stage 2: compile the TypeScript MCP server ---
FROM node:22-bookworm AS appbuild
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# --- Stage 3: runtime (same glibc base as the rust build) ---
FROM node:22-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    VAULT_ROOT=/vault \
    VAULT_QUERY_BIN=/usr/local/bin/vault-query
COPY --from=vqbuild /usr/local/bin/vault-query /usr/local/bin/vault-query
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=appbuild /app/dist ./dist
# OAuth state (clients + live tokens) persists here. Own it as node before the
# named volume mounts: a fresh volume inherits the image dir's node ownership, so
# the non-root runtime can write /data/oauth.json.
RUN mkdir -p /data && chown node:node /data
USER node
EXPOSE 3000
CMD ["node", "dist/server.js"]
