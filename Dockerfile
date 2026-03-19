# =============================================================================
# Reolink Baichuan Dashboard - Docker Build
# Multi-stage build — NO QEMU emulation needed.
#
# Strategy: build everything on amd64 (JS is cross-platform), then use
# TARGETARCH to select the correct go2rtc binary and base image.
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

# Download go2rtc binaries for all target architectures
RUN apk add --no-cache curl && \
    GO2RTC_VERSION="1.9.4" && \
    mkdir -p /go2rtc && \
    curl -fsSL -o /go2rtc/go2rtc-amd64 \
      "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_amd64" && \
    curl -fsSL -o /go2rtc/go2rtc-arm64 \
      "https://github.com/AlexxIT/go2rtc/releases/download/v${GO2RTC_VERSION}/go2rtc_linux_arm64" && \
    chmod +x /go2rtc/go2rtc-*

# -----------------------------------------------------------------------------
# Stage 2: Production runtime (multi-arch via base image, zero emulation)
# -----------------------------------------------------------------------------
FROM node:22-alpine AS production

ARG TARGETARCH

# Install ffmpeg for snapshot transcoding and su-exec for entrypoint
RUN apk add --no-cache ffmpeg su-exec

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

# Copy the correct go2rtc binary for this architecture
COPY --from=builder /go2rtc/go2rtc-${TARGETARCH} /usr/local/bin/go2rtc

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
ENV GO2RTC_PATH=/usr/local/bin/go2rtc
ENV GO2RTC_API_PORT=1984
ENV GO2RTC_RTSP_PORT=8554
ENV GO2RTC_WEBRTC_PORT=8555

EXPOSE 3000 1984 8554 8555

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

ENTRYPOINT ["docker-entrypoint.sh"]
