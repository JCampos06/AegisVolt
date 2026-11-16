#!/usr/bin/env bash
# Smoke test del ambiente desplegado en kind: GraphQL por el Ingress NGINX.
#   bash scripts/smoke-k8s.sh <dev|test|prod>
# Verifica que el gateway responde, que está en el ambiente correcto y que llega
# a los servicios internos (la query de estaciones pasa por station-reservation).
set -euo pipefail

ENV="${1:?uso: smoke-k8s.sh <dev|test|prod>}"
HOST="$ENV.aegisvolt.localhost"
PORT="${INGRESS_PORT:-8080}"
URL="http://$HOST:$PORT/graphql"

# --resolve: no depende de que el sistema resuelva *.localhost
body='{"query":"{ environment stations { id } }"}'
for i in 1 2 3 4 5; do
  if out="$(curl -sS -m 10 --resolve "$HOST:$PORT:127.0.0.1" -H 'content-type: application/json' -d "$body" "$URL")"; then
    break
  fi
  echo "    reintento $i..."; sleep 3
done

echo "    $URL -> ${out:0:200}"
case "$out" in
  *"\"environment\":\"$ENV\""*'"stations":['*) echo "==> Smoke test $ENV OK" ;;
  *) echo "==> Smoke test $ENV FALLÓ"; exit 1 ;;
esac
