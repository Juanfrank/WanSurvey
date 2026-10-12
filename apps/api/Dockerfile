# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/logic/package.json packages/logic/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @wansurvey/api...
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @wansurvey/api... build \
  && pnpm deploy --filter @wansurvey/api --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
CMD ["node", "dist/main.js"]
