#!/usr/bin/env bash
# Vendor the vault-query Rust source into ./.vault-query-src so the Docker build
# (context ./mcp) can COPY it. Docker cannot reach a source tree outside its build
# context, so we stage the build inputs here. Run before `docker compose build mcp`.
#
# Override the source location with VAULT_QUERY_SRC (default: ~/nix/vault-query).
set -euo pipefail

SRC="${VAULT_QUERY_SRC:-$HOME/nix/vault-query}"
DEST="$(cd "$(dirname "$0")" && pwd)/.vault-query-src"

if [ ! -f "$SRC/Cargo.toml" ]; then
  echo "error: no Cargo.toml at $SRC — set VAULT_QUERY_SRC to the vault-query source dir" >&2
  exit 1
fi

rm -rf "$DEST"
mkdir -p "$DEST"
# Copy only the build inputs; exclude the (large) target dir and non-build trees.
rsync -a \
  --exclude 'target/' \
  --exclude '.git/' \
  --exclude 'eval/' \
  --exclude 'tests/' \
  --exclude '.claude-plans/' \
  "$SRC/Cargo.toml" "$SRC/Cargo.lock" "$SRC/src" \
  "$DEST/"

echo "vendored vault-query source from $SRC -> $DEST"
