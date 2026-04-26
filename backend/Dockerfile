ARG NODE_DEBIAN_IMAGE=node:20-bookworm-slim
ARG NODE_ALPINE_IMAGE=node:20-alpine3.22

FROM ${NODE_DEBIAN_IMAGE} AS backend-build

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
RUN npm ci

COPY backend/tsconfig.json ./
COPY backend/src ./src
RUN npm run build
RUN npm prune --omit=dev

FROM ${NODE_ALPINE_IMAGE} AS frontend-build

WORKDIR /frontend

COPY frontend/package*.json ./
RUN npm ci

COPY frontend/tsconfig.json frontend/tsconfig.node.json frontend/vite.config.ts frontend/index.html ./
COPY frontend/public ./public
COPY frontend/src ./src

RUN npm run build

FROM ${NODE_DEBIAN_IMAGE} AS runtime

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends ffmpeg \
  && rm -rf /var/lib/apt/lists/*

COPY backend/package*.json ./
COPY --from=backend-build /app/node_modules ./node_modules
COPY --from=backend-build /app/dist ./dist
COPY --from=frontend-build /frontend/dist ./public
COPY backend/start.sh ./start.sh

RUN mkdir -p storage \
  && rm -rf /usr/local/lib/node_modules/npm \
  && rm -f /usr/local/bin/npm /usr/local/bin/npx \
  && chmod +x ./start.sh

ENV NODE_ENV=production
ENV FRONTEND_DIR=public
EXPOSE 4100

CMD ["./start.sh"]
