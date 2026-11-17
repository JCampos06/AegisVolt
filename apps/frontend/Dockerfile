# syntax=docker/dockerfile:1
# -----------------------------------------------------------------------------
# Imagen del frontend (contexto = raíz del monorepo, por el lockfile de pnpm):
#   docker build -f apps/frontend/Dockerfile --build-arg APP_VERSION=<sha> -t aegisvolt/frontend:<sha> .
#
#   build   -> Vite compila la SPA (la misma imagen sirve dev, test y prod: el
#              ambiente se lee del gateway en tiempo de ejecución)
#   runtime -> nginx sin privilegios: sirve la SPA y, si la petición llega a él,
#              reenvía /graphql (HTTP y WebSocket) a GRAPHQL_UPSTREAM
# -----------------------------------------------------------------------------
ARG NODE_IMAGE=node:24.22.3-alpine3.24
ARG NGINX_IMAGE=nginxinc/nginx-unprivileged:1.28.0-alpine

FROM ${NODE_IMAGE} AS build
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store pnpm fetch
COPY package.json ./
COPY apps/frontend ./apps/frontend
ARG APP_VERSION=0.0.0-local
ENV VITE_APP_VERSION=${APP_VERSION}
RUN --mount=type=cache,id=pnpm-store,target=/root/.local/share/pnpm/store \
    pnpm install --offline --frozen-lockfile --filter frontend \
 && pnpm --filter frontend build

FROM ${NGINX_IMAGE} AS runtime
ARG APP_VERSION=0.0.0-local
# La plantilla se resuelve al arrancar (envsubst del entrypoint oficial) y se
# escribe en /tmp: el resto del sistema de archivos es de solo lectura en k8s.
ENV APP_VERSION=${APP_VERSION} \
    GRAPHQL_UPSTREAM=http://graphql-gateway \
    NGINX_ENVSUBST_OUTPUT_DIR=/tmp
COPY apps/frontend/nginx/nginx.conf /etc/nginx/nginx.conf
COPY apps/frontend/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /repo/apps/frontend/dist /usr/share/nginx/html
EXPOSE 8080
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8080/healthz >/dev/null || exit 1
