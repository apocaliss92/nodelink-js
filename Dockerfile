# =============================================================================
# Reolink Baichuan Dashboard - Docker Build
# Multi-stage build: library + app in single container
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Build the main library
# -----------------------------------------------------------------------------
FROM node:20-alpine AS lib-builder

WORKDIR /lib

# Copy library source files
COPY package*.json ./
COPY tsconfig.json ./
COPY tsup.config.ts ./
COPY api-extractor.json ./
COPY src/ ./src/

# Install dependencies and build
RUN npm install --ignore-scripts
RUN npm run build:js

# -----------------------------------------------------------------------------
# Stage 2: Build the app
# -----------------------------------------------------------------------------
FROM node:20-alpine AS app-builder

WORKDIR /build

# Copy built library from previous stage
COPY --from=lib-builder /lib /lib

# Copy app source files
COPY app/package*.json ./
COPY app/tsconfig.json ./
COPY app/tsup.config.ts ./
COPY app/vite.config.ts ./
COPY app/src/ ./src/
COPY app/client/ ./client/

# Install dependencies (will resolve file:.. from /lib)
# Need to update package.json to point to correct path
RUN sed -i 's|"file:.."|"file:/lib"|g' package.json
RUN npm install --ignore-scripts

# Build app
RUN npm run build

# -----------------------------------------------------------------------------
# Stage 3: Production runtime
# -----------------------------------------------------------------------------
FROM node:20-alpine AS production

# Install ffmpeg for MJPEG streaming
RUN apk add --no-cache ffmpeg

WORKDIR /app

# Create non-root user for security
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001

# Copy built library and install its dependencies
COPY --from=lib-builder /lib/dist /lib/dist
COPY --from=lib-builder /lib/package.json /lib/package.json
COPY --from=lib-builder /lib/package-lock.json /lib/package-lock.json
WORKDIR /lib
ENV NODE_ENV=production
RUN npm install --ignore-scripts
WORKDIR /app

# Copy app package.json and update library path
COPY app/package*.json ./
RUN sed -i 's|"file:.."|"file:/lib"|g' package.json

# Install production dependencies only
# Using npm install instead of npm ci because we modify the library path
ENV NODE_ENV=production
RUN npm install --ignore-scripts

# Copy built app (server.js and public/ with React client)
COPY --from=app-builder /build/dist ./dist

# Create directories for data persistence
RUN mkdir -p /data/logs && chown -R nodejs:nodejs /data

# Default settings will be created on first run
# Mount /data for persistence

# Switch to non-root user
USER nodejs

# Environment variables
ENV NODE_ENV=production
ENV PORT=3000
ENV RTSP_PROXY_PORT=8554
ENV SETTINGS_PATH=/data
ENV LOGS_PATH=/data/logs

# Expose ports
EXPOSE 3000
EXPOSE 8554

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "dist/server.js"]
