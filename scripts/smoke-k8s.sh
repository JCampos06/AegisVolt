#!/usr/bin/env bash
# Smoke test del ambiente desplegado en kind, por el Ingress NGINX.
#   bash scripts/smoke-k8s.sh <dev|test|prod>
# Verifica que:
#   1. /graphql responde, está en el ambiente correcto y llega a los servicios
#      internos (la query de estaciones pasa por station-reservation)
#   2. / sirve la SPA del frontend (index.html con la raíz de React)
set -euo pipefail

ENV="${1:?uso: smoke-k8s.sh <dev|test|prod>}"
HOST="$ENV.aegisvolt.localhost"
PORT="${INGRESS_PORT:-8080}"
BASE="http://$HOST:$PORT"
# --resolve: no depende de que el sistema resuelva *.localhost
CURL=(curl -sS -m 10 --resolve "$HOST:$PORT:127.0.0.1")

body='{"query":"{ environment stations { id } }"}'
out=""
for i in 1 2 3 4 5; do
  if out="$("${CURL[@]}" -H 'content-type: application/json' -d "$body" "$BASE/graphql")"; then
    break
  fi
  echo "    reintento $i..."; sleep 3
done
echo "    $BASE/graphql -> ${out:0:200}"
case "$out" in
  *"\"environment\":\"$ENV\""*'"stations":['*) ;;
  *) echo "==> Smoke test $ENV FALLÓ (gateway)"; exit 1 ;;
esac

ui="$("${CURL[@]}" "$BASE/" || true)"
case "$ui" in
  *'<div id="root">'*) echo "    $BASE/ -> SPA del frontend" ;;
  *) echo "    $BASE/ -> ${ui:0:200}"; echo "==> Smoke test $ENV FALLÓ (frontend)"; exit 1 ;;
esac

echo "==> Smoke test $ENV OK"
