# ---- stage 1: build the web app (React + Vite) ----
FROM oven/bun:1 AS web
WORKDIR /web
COPY web/package.json web/bun.lock* ./
RUN bun install --frozen-lockfile
COPY web/ ./
RUN bun run build

# ---- stage 2: the server image (API + workers share it; the API also serves the built web app) ----
FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY tsconfig.json ./
COPY src ./src
COPY --from=web /web/dist ./web/dist
USER bun
# every service overrides CMD in docker-compose.yml
CMD ["bun", "run", "src/api/server.ts"]
