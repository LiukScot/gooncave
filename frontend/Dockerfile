ARG BUN_IMAGE=oven/bun:1.3.11

FROM ${BUN_IMAGE} AS build

WORKDIR /app

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY tsconfig.json tsconfig.node.json vite.config.ts index.html ./
COPY public ./public
COPY src ./src

ARG VITE_API_BASE_URL=http://localhost:4100
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN bun run build

FROM nginx:1.31.3-alpine

COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 5174

USER nginx

CMD ["nginx", "-g", "daemon off;"]
