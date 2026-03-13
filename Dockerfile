# =============================================================================
# Reolink Baichuan Dashboard - Docker Build
# Multi-stage build: library + app in single container
# =============================================================================

# Builder stages are forced to linux/amd64 because they produce pure
# JavaScript/CSS artifacts — no platform-specific binaries. This avoids
# extremely slow QEMU arm64 emulation during multi-arch builds.

# -----------------------------------------------------------------------------
# Stage 1: Build library + app
# -----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-alpine AS builder

# Build the library
WORKDIR /lib
COPY package*.json ./
COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY api-extractor.json ./
COPY src/ ./src/
RUN npm install --ignore-scripts && npm run build:js

# Build the app (reuses /lib in-place, single npm install)
WORKDIR /build
COPY app/package*.json ./
COPY app/tsconfig.json ./
COPY app/tsup.config.ts ./
COPY app/vite.config.ts ./
COPY app/src/ ./src/
COPY app/client/ ./client/
RUN sed -i 's|"file:.."|"file:/lib"|g' package.json
RUN npm install --ignore-scripts && npm run build

# -----------------------------------------------------------------------------
# Stage 2: Production runtime (multi-arch: amd64 + arm64)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS production

# Install ffmpeg for MJPEG streaming and su-exec for entrypoint
RUN apk add --no-cache ffmpeg su-exec

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built library and install its production dependencies
COPY --from=builder /lib/dist /lib/dist
COPY --from=builder /lib/package.json /lib/package.json
COPY --from=builder /lib/package-lock.json /lib/package-lock.json
WORKDIR /lib
ENV NODE_ENV=production
RUN npm install --ignore-scripts
WORKDIR /app

# Copy app package.json and install production dependencies
COPY app/package*.json ./
RUN sed -i 's|"file:.."|"file:/lib"|g' package.json
ENV NODE_ENV=production
RUN npm install --ignore-scripts

# Copy built app (server.js and public/ with React client)
COPY --from=builder /build/dist ./dist

# Copy entrypoint script
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create data directory (will be overlaid by volume mount)
RUN mkdir -p /data/logs && chown -R nodejs:nodejs /data

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV RTSP_PORT=8554
ENV DATA_PATH=/data

# Expose ports
EXPOSE 3000
EXPOSE 8554

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Use entrypoint to handle permissions and start as nodejs user
ENTRYPOINT ["docker-entrypoint.sh"]
