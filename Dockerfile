# Update this digest deliberately alongside the lockfile/runtime checks.
ARG NODE_IMAGE=node:24-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf
# Build the admin panel
FROM ${NODE_IMAGE} AS frontend-builder
WORKDIR /app
# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apk add --no-cache python3 make g++
# Both manifests, because the root package.json declares a workspace and npm
# refuses to install without the workspace's own package.json present.
COPY package*.json ./
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/
RUN npm ci
COPY . .
# Builds the plugin SDK first (it is the first project reference), then the UI.
RUN npm run build

# Runtime: Express API + Discord bot, run from TypeScript via tsx
FROM ${NODE_IMAGE}
WORKDIR /app

COPY package*.json ./
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/
# git stays in the image, unlike the build toolchain below. Installing a plugin
# from a repository shells out to `git clone`, and node:alpine ships no git, so
# without this every repository install fails with "spawn git ENOENT".
RUN apk add --no-cache git \
 && apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm ci --omit=dev \
 && apk del .build-deps

COPY src/server ./src/server
COPY src/shared ./src/shared
COPY drizzle ./drizzle
COPY tsconfig*.json ./
# The SDK is the one thing here that is compiled rather than run from source.
# npm ci above created the workspace link; this is what it points at.
COPY --from=frontend-builder /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 3000
ENV NODE_ENV=production

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health',{signal:AbortSignal.timeout(4000)}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Use the lockfile's local loader and keep Node as the foreground process.
CMD ["node", "--import", "tsx", "src/server/index.ts"]
