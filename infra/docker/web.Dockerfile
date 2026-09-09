# Admin dashboard — static build served by nginx, which also proxies /api
# to the backend so the browser only ever talks to one origin.
FROM node:22-bookworm-slim AS build
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install
RUN pnpm --filter "@signage/web..." build

# nginx-unprivileged instead of the stock image: it runs as uid 101 rather than
# root and is pre-configured for a non-root filesystem (pid file, caches, temp
# paths). The consequence is that it listens on 8080, not 80 — a non-root process
# cannot bind a privileged port without CAP_NET_BIND_SERVICE. Four other places
# encode that port: web-nginx.conf's `listen`, this EXPOSE, the compose port
# mapping and healthcheck, and Caddy's `reverse_proxy web:8080`.
FROM nginxinc/nginx-unprivileged:1.27-alpine
COPY infra/docker/web-nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
