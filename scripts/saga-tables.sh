#!/usr/bin/env bash
# Muestra lo que dejó una saga en cada tabla de DynamoDB del ambiente:
# la saga (orquestador), la reserva y el conector (reservas), el cobro y el saldo
# (billing) y la sesión (dispatch). Sirve para comprobar una compensación:
# cobro REFUNDED + reserva RELEASED + conector AVAILABLE.
#
#   bash scripts/saga-tables.sh <correlation_id> <dev|test|prod>
set -euo pipefail
export MSYS_NO_PATHCONV=1 AWS_CLI_OUTPUT_ENCODING=UTF-8

ID="${1:?Uso: saga-tables.sh <correlation_id> <dev|test|prod>}"
ENV="${2:?Uso: saga-tables.sh <correlation_id> <dev|test|prod>}"
case "$ENV" in dev|test|prod) ;; *) echo "Ambiente inválido: $ENV" >&2; exit 1 ;; esac

if command -v aws >/dev/null 2>&1; then
  export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}" AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
         AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
  aws_() { aws "$@"; }
else
  aws_() { docker exec "${FLOCI_CONTAINER:-aegisvolt-floci}" aws --endpoint-url http://localhost:4566 "$@"; }
fi

key() { printf '{"PK":{"S":"%s"},"SK":{"S":"%s"}}' "$1" "$2"; }
get() { # get <tabla> <PK> <SK> <query JMESPath>
  aws_ dynamodb get-item --table-name "aegisvolt-$1-$ENV" --key "$(key "$2" "$3")" \
    --query "$4" --output text 2>/dev/null | tr -d '\r' || true
}

SAGA="$(get sagas "SAGA#$ID" META 'Item.[status.S, fleetId.S, stationId.S, connectorId.S]')"
if [ -z "$SAGA" ] || [ "$SAGA" = "None" ]; then
  echo "No existe la saga $ID en aegisvolt-sagas-$ENV" >&2; exit 1
fi
read -r STATUS FLEET STATION CONNECTOR <<<"$SAGA"

row() { printf '  %-30s %-48s %s\n' "$1" "$2" "$3"; }
echo "Saga $ID en $ENV"
echo
row "TABLA" "ÍTEM" "ESTADO"
row "aegisvolt-sagas-$ENV" "SAGA#$ID" "$STATUS"
row "aegisvolt-reservations-$ENV" "RESERVATION#$ID" "$(get reservations "RESERVATION#$ID" META 'Item.status.S')"
row "aegisvolt-reservations-$ENV" "STATION#$STATION / CONNECTOR#$CONNECTOR" \
  "$(get reservations "STATION#$STATION" "CONNECTOR#$CONNECTOR" 'Item.[status.S, sagaId.S]' | sed 's/\tNone$//; s/\t/  saga=/')"
row "aegisvolt-billing-$ENV" "WALLET#$FLEET / TX#$ID" \
  "$(get billing "WALLET#$FLEET" "TX#$ID" 'Item.[status.S, amount.N]' | sed 's/\t/  monto=/')"
row "aegisvolt-billing-$ENV" "WALLET#$FLEET / META" "saldo=$(get billing "WALLET#$FLEET" META 'Item.balance.N')"
row "aegisvolt-dispatch-$ENV" "SESSION#$ID" \
  "$(get dispatch "SESSION#$ID" META 'Item.[status.S, failureReason.S]' | sed 's/\tNone$//; s/\t/  /')"
