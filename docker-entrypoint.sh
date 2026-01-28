#!/bin/sh
set -e

# Create data directories if they don't exist (for mounted volumes)
mkdir -p "${DATA_PATH:-/data}/logs"

# Fix ownership if running as root
if [ "$(id -u)" = "0" ]; then
    chown -R nodejs:nodejs "${DATA_PATH:-/data}"
    exec su-exec nodejs node dist/server.js
else
    exec node dist/server.js
fi
