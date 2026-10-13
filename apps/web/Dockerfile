# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages packages
COPY apps/web apps/web
RUN pnpm install --frozen-lockfile --filter @wansurvey/web... \
  && pnpm --filter @wansurvey/web... build

FROM nginx:1.27-alpine
# Filled in at start: where /api goes (see infra/nginx/templates/default.conf.template).
ENV API_UPSTREAM=http://api:3000
COPY infra/nginx/templates /etc/nginx/templates
COPY --from=build /repo/apps/web/dist /usr/share/nginx/html
EXPOSE 8080
