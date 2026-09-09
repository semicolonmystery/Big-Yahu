# Build the admin panel
FROM node:24-alpine AS frontend-builder
WORKDIR /app
# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apk add --no-cache python3 make g++
# Both manifests, because the root package.json declares a workspace and npm
# refuses to install without the workspace's own package.json present.
COPY package*.json ./
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/
RUN npm install
COPY . .
# Builds the plugin SDK first (it is the first project reference), then the UI.
RUN npm run build

# Runtime: Express API + Discord bot, run from TypeScript via tsx
FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
COPY packages/plugin-sdk/package.json ./packages/plugin-sdk/
# git stays in the image, unlike the build toolchain below. Installing a plugin
# from a repository shells out to `git clone`, and node:alpine ships no git, so
# without this every repository install fails with "spawn git ENOENT".
RUN apk add --no-cache git \
 && apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm install --omit=dev \
 && npm install -g tsx \
 && apk del .build-deps

COPY src/server ./src/server
COPY src/shared ./src/shared
COPY drizzle ./drizzle
COPY tsconfig*.json ./
# The SDK is the one thing here that is compiled rather than run from source.
# npm install above created the workspace link; this is what it points at.
COPY --from=frontend-builder /app/packages/plugin-sdk/dist ./packages/plugin-sdk/dist
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 3000
ENV NODE_ENV=production

CMD ["tsx", "src/server/index.ts"]
