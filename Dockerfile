# The API and the keeper, one image for both: WEIR_SERVICE picks which runs.
#   WEIR_SERVICE=api     the relayer, the index and the HTTP API
#   WEIR_SERVICE=keeper  the keeper that charges due mandates
# Every setting comes from the environment (see .env.example); nothing secret is baked in.

FROM node:22-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
# Every workspace manifest, so the lockfile matches; only the API, the keeper and what they use install.
COPY packages/shared/package.json packages/shared/
COPY packages/agent-wallet-plugin/package.json packages/agent-wallet-plugin/
COPY apps/api/package.json apps/api/
COPY apps/keeper/package.json apps/keeper/
COPY apps/web/package.json apps/web/
COPY apps/landing/package.json apps/landing/
COPY apps/cre-keeper/package.json apps/cre-keeper/
RUN pnpm install --frozen-lockfile --filter weir --filter "@weir/api..." --filter "@weir/keeper..."
COPY packages/shared packages/shared
COPY apps/api apps/api
COPY apps/keeper apps/keeper
RUN pnpm --filter @weir/shared build

FROM base
COPY --from=build /app /app
ENV NODE_ENV=production WEIR_SERVICE=api KEEPER_HOST=0.0.0.0
CMD ["sh", "-c", "if [ \"$WEIR_SERVICE\" = keeper ]; then exec pnpm exec tsx apps/keeper/src/index.ts; else cd apps/api && exec pnpm exec tsx --tsconfig tsconfig.json src/main.ts; fi"]
