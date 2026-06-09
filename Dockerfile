# =============================================================================
# Reolink Baichuan Dashboard - Docker Build
# Multi-stage build — NO QEMU emulation needed (JS is cross-platform; the
# alpine base image is per-arch).
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build library + app + deps (amd64 only — fast, no emulation)
# -----------------------------------------------------------------------------
FROM --platform=linux/amd64 node:22-alpine AS builder

ARG TARGETARCH

# Build the library
WORKDIR /lib
COPY package*.json ./
COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY api-extractor.json ./
COPY src/ ./src/
RUN npm install --ignore-scripts && npm run build:js
# Production deps only
RUN rm -rf node_modules && npm install --ignore-scripts --omit=dev

# Build the app
WORKDIR /build
COPY app/package*.json ./
COPY app/tsconfig.json ./
COPY app/tsup.config.ts ./
COPY app/vite.config.ts ./
COPY app/src/ ./src/
COPY app/client/ ./client/
RUN sed -i 's|"file:.."|"file:/lib"|g' package.json
RUN npm install --ignore-scripts && npm run build
# Production deps only
RUN rm -rf node_modules && npm install --ignore-scripts --omit=dev

# -----------------------------------------------------------------------------
# Stage 2: Production runtime (multi-arch via base image, zero emulation)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS production

ARG TARGETARCH

# Install ffmpeg (snapshot transcoding for the diagnostics analyzer),
# su-exec (entrypoint user drop) and tshark (in-app packet capture). The
# capture tool needs CAP_NET_RAW + CAP_NET_ADMIN; we set them on the
# binaries so the container's non-root nodejs user can capture without
# --privileged. At runtime the container also needs the caps from
# `docker run` / compose — see README for the recommended `--cap-add` /
# `--net=host` flags.
RUN apk add --no-cache ffmpeg su-exec tshark libcap && \
    setcap 'cap_net_raw,cap_net_admin+eip' /usr/bin/dumpcap || true

WORKDIR /app

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy library (dist + production node_modules)
COPY --from=builder /lib/dist /lib/dist
COPY --from=builder /lib/package.json /lib/package.json
COPY --from=builder /lib/node_modules /lib/node_modules

# Copy app (dist + production node_modules)
COPY --from=builder /build/dist ./dist
COPY --from=builder /build/package.json ./package.json
COPY --from=builder /build/node_modules ./node_modules

# Copy entrypoint
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh

# Create data directory
RUN mkdir -p /data/logs && chown -R nodejs:nodejs /data

# App version (build-arg, shown in UI)
ARG APP_VERSION=dev
ENV APP_VERSION=${APP_VERSION}

ENV NODE_ENV=production
ENV PORT=3000
ENV DATA_PATH=/data

# 3000 = manager UI / tRPC, 8554 = RTSP (video + Frigate backchannel),
# 8555/udp = WebRTC ICE for the in-process player.
EXPOSE 3000 8554 8555/udp

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
