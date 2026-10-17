# syntax=docker/dockerfile:1
FROM node:22-slim AS build
WORKDIR /repo
RUN corepack enable
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json turbo.json tsconfig.base.json ./
COPY packages/schema/package.json packages/schema/
COPY packages/logic/package.json packages/logic/
COPY packages/fixtures/package.json packages/fixtures/
COPY packages/exporters/package.json packages/exporters/
COPY apps/api/package.json apps/api/
RUN pnpm install --frozen-lockfile --filter @wansurvey/api...
COPY packages packages
COPY apps/api apps/api
RUN pnpm --filter @wansurvey/api... build \
  && pnpm deploy --filter @wansurvey/api --prod --legacy /out

FROM node:22-slim
ENV NODE_ENV=production
# pdftoppm, to read scanned paper forms (the worker uses it).
RUN apt-get update \
  && apt-get install -y --no-install-recommends poppler-utils \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
# The worker is the same image: `node dist/worker.js` (M1).
CMD ["node", "dist/main.js"]
