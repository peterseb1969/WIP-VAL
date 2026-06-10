# Stage 1: Build
FROM node:20-alpine AS build
WORKDIR /app

# Copy package files and lib tarballs first for cache efficiency
COPY package.json package-lock.json ./
COPY libs/ libs/
RUN npm ci --ignore-scripts

# Copy source and build
# VITE_BASE_PATH sets the public base path for assets (e.g. /apps/wip-val/)
ARG VITE_BASE_PATH=/
ENV VITE_BASE_PATH=${VITE_BASE_PATH}
COPY . .
RUN npm run build

# Stage 2: Production server
FROM node:20-alpine AS production
WORKDIR /app

# Install only production dependencies (tsx is a runtime dep — the server
# entry runs through it, so it must survive --omit=dev)
COPY package.json package-lock.json ./
COPY libs/ libs/
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy server source (run via tsx). Includes server/prompts/ which agent.ts
# reads at runtime.
COPY server/ server/
COPY tsconfig.json ./

# Seed files for /api/bootstrap/run (provisions wip-val on a fresh instance)
COPY data-model/ data-model/

# Copy built frontend
COPY --from=build /app/dist dist/

ENV NODE_ENV=production
ENV PORT=3015

EXPOSE 3015

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3015${APP_BASE_PATH:-}/api/health || exit 1

CMD ["npx", "tsx", "server/index.ts"]
