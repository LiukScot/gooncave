ARG BUN_IMAGE=oven/bun:1.3.11
ARG NODE_DEBIAN_IMAGE=node:20-bookworm-slim

FROM ${BUN_IMAGE} AS backend-build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile

COPY backend/tsconfig.json ./
COPY backend/scripts ./scripts
COPY backend/src ./src
RUN bun run build

FROM ${BUN_IMAGE} AS backend-prod-deps

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json backend/bun.lock ./
RUN bun install --frozen-lockfile --production

FROM ${BUN_IMAGE} AS frontend-build

WORKDIR /frontend

COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend/tsconfig.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/public ./public
COPY frontend/src ./src

RUN bun run build

FROM ${NODE_DEBIAN_IMAGE} AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package.json ./
COPY --from=backend-prod-deps /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /frontend/dist ./public
COPY backend/start.sh ./start.sh

RUN mkdir -p storage \
  && chmod +x ./start.sh

ENV NODE_ENV=production
ENV FRONTEND_DIR=public
EXPOSE 4100

CMD ["./start.sh"]
