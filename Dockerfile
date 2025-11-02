FROM couchdb:3.3

# Prevent interactive prompts
ENV DEBIAN_FRONTEND=noninteractive

# Install additional tools
RUN apt-get update && apt-get install -y \
    curl \
    git \
    ca-certificates \
    wireguard \
    wireguard-tools \
    certbot \
    iproute2 \
    bash \
    && rm -rf /var/lib/apt/lists/*

# Create directories
RUN mkdir -p /app/wireguard /scripts

# Download couchdb initialization script
RUN curl -s https://raw.githubusercontent.com/vrtmrz/obsidian-livesync/main/utils/couchdb/couchdb-init.sh -o /scripts/couchdb-init.sh && \
    chmod +x /scripts/couchdb-init.sh

# Expose ports
EXPOSE 5984 51820

# CouchDB runs by default, CMD can be overridden for init
CMD ["couchdb"]
