# Build the admin panel
FROM node:24-alpine AS frontend-builder
WORKDIR /app
# better-sqlite3 falls back to compiling from source when no prebuild matches.
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install
COPY . .
RUN npm run build

# Runtime: Express API + Discord bot, run from TypeScript via tsx
FROM node:24-alpine
WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ \
 && npm install --omit=dev \
 && npm install -g tsx \
 && apk del .build-deps

COPY src/server ./src/server
COPY src/shared ./src/shared
COPY drizzle ./drizzle
COPY tsconfig*.json ./
COPY --from=frontend-builder /app/dist ./dist

EXPOSE 3000
ENV NODE_ENV=production

CMD ["tsx", "src/server/index.ts"]
