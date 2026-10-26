# syntax=docker/dockerfile:1
FROM node:24-slim AS build
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

FROM node:24-slim
ENV NODE_ENV=production
# tini, so Node is not PID 1:
# signals reach it (a clean shutdown drains jobs and connections) and zombies are reaped.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=build /out ./
USER node
EXPOSE 3000
# The API answers /health; the worker (the same image, `node dist/worker.js`, M1) has no
# port, so its container overrides or disables this check.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/main.js"]
