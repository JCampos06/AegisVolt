# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# Imagen de cualquier servicio del monorepo (multi-stage):
#   docker build --build-arg SERVICE=billing-wallet-service -t aegisvolt/billing-wallet-service:<sha> .
#
#   deps    -> descarga dependencias solo con el lockfile (caché estable)
#   build   -> compila shared + el servicio y arma un paquete con solo prod deps
#   runtime -> node:alpine mínimo, usuario no root, HEALTHCHECK
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:24.22.3-alpine3.24

FROM ${NODE_IMAGE} AS deps
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /repo
# Solo el lockfile: esta capa no se invalida al cambiar código.
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch

FROM deps AS build
ARG SERVICE
COPY . .
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter "${SERVICE}..." \
 && pnpm --filter "${SERVICE}..." build \
 && pnpm --filter "${SERVICE}" deploy --legacy --prod /out

FROM ${NODE_IMAGE} AS runtime
ARG SERVICE
ARG APP_VERSION=0.0.0-local
ENV NODE_ENV=production \
    APP_VERSION=${APP_VERSION} \
    SERVICE=${SERVICE}
WORKDIR /app
COPY --from=build --chown=node:node /out ./
USER node
# PORT lo define cada servicio (compose / ConfigMap de k8s).
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- "http://127.0.0.1:${PORT}/health/live" >/dev/null || exit 1
CMD ["node", "dist/server.js"]
