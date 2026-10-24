# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile --filter @wansurvey/web... \
  && pnpm --filter @wansurvey/web... build

# nginx without root: the workers and the master run as the nginx user, on port 8080.
FROM nginxinc/nginx-unprivileged:1.27-alpine
# Filled in at start: where /api goes (see infra/nginx/templates/default.conf.template).
ENV API_UPSTREAM=http://api:3000
COPY infra/nginx/templates /etc/nginx/templates
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O /dev/null http://127.0.0.1:8080/ || exit 1
