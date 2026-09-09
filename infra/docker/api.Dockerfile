# Backend API image. Also used by the one-shot "migrate" compose service,
# so it keeps the prisma CLI and the migrations directory.
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
RUN corepack enable
WORKDIR /app

COPY . .
RUN pnpm install
RUN pnpm --filter @signage/database generate
RUN pnpm --filter "@signage/api..." build

FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /app /app
ENV NODE_ENV=production
# Drop root. The node:22-bookworm-slim base already provides an unprivileged
# `node` user. /app is world-readable so the app can be read, and the only
# runtime writes go to os.tmpdir() (/tmp), which stays writable.
USER node
EXPOSE 4000
CMD ["node", "apps/api/dist/main.js"]
