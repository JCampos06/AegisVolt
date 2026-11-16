#!/usr/bin/env bash
# Reconstruye una saga desde CloudWatch Logs: busca el correlation_id en los
# 4 log groups del ambiente y muestra los eventos ordenados por tiempo.
#
#   bash scripts/trace-saga.sh <correlation_id> <dev|test|prod>
set -euo pipefail
export MSYS_NO_PATHCONV=1 AWS_CLI_OUTPUT_ENCODING=UTF-8

ID="${1:?Uso: trace-saga.sh <correlation_id> <dev|test|prod>}"
ENV="${2:?Uso: trace-saga.sh <correlation_id> <dev|test|prod>}"
case "$ENV" in dev|test|prod) ;; *) echo "Ambiente inválido: $ENV" >&2; exit 1 ;; esac

if command -v aws >/dev/null 2>&1; then
  export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}" AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
         AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
  aws_() { aws "$@"; }
else
  aws_() { docker exec "${FLOCI_CONTAINER:-aegisvolt-floci}" aws --endpoint-url http://localhost:4566 "$@"; }
fi

SERVICES=(graphql-gateway station-reservation-service billing-wallet-service energy-dispatch-service)
for svc in "${SERVICES[@]}"; do
  aws_ logs filter-log-events --log-group-name "/aegisvolt/${ENV}/${svc}" \
    --filter-pattern "\"${ID}\"" --query 'events[].message' --output json 2>/dev/null || true
  echo
done | node -e '
const fs = require("fs");
const id = process.argv[1], env = process.argv[2];
const rows = [];
for (const chunk of fs.readFileSync(0, "utf8").split(/\n(?=\[)/)) {
  const t = chunk.trim(); if (!t) continue;
  for (const m of JSON.parse(t)) { try { rows.push(JSON.parse(m)); } catch {} }
}
rows.sort((a, b) => String(a.timestamp).localeCompare(String(b.timestamp)));
if (!rows.length) { console.log(`Sin eventos para ${id} en /aegisvolt/${env}/* (los logs tardan ~2 s en llegar).`); process.exit(1); }
const pad = (s, n) => String(s ?? "").padEnd(n).slice(0, n);
console.log(`Saga ${id} en ${env}: ${rows.length} eventos\n`);
console.log(pad("hora", 13), pad("servicio", 28), pad("nivel", 5), pad("paso", 9), pad("http", 4), "mensaje");
for (const r of rows) {
  const extra = [r.saga_status && `saga=${r.saga_status}`, r.errorCode && `code=${r.errorCode}`, r.attempt && `intento=${r.attempt}`,
                 r.alreadyApplied && "alreadyApplied", r.outcome && `outcome=${r.outcome}`].filter(Boolean).join(" ");
  console.log(pad(String(r.timestamp).slice(11, 23), 13), pad(r.service, 28), pad(r.level, 5), pad(r.saga_step ?? "", 9),
              pad(r.statusCode ?? "", 4), r.message, extra ? `(${extra})` : "");
}' "$ID" "$ENV"
