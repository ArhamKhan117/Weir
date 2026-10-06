# The Envio HyperIndex project, self-hosted beside its own Postgres. Every setting comes from the
# environment: ENVIO_API_TOKEN, ENVIO_PG_HOST/PORT/USER/PASSWORD/DATABASE, and optionally
# ENVIO_RPC_URL_<chainId>. Without Hasura there is no GraphQL here; the Weir API reads the tables.

FROM node:22-slim
ENV CI=true ENVIO_HASURA=false
RUN corepack enable && corepack prepare pnpm@10.7.0 --activate
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile --ignore-workspace
COPY . .
CMD ["pnpm", "local"]
