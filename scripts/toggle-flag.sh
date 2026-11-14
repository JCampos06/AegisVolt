#!/usr/bin/env bash
# Cambia una feature flag EN CALIENTE (sin redeploy) en la tabla del ambiente.
#
#   bash scripts/toggle-flag.sh <env>                     # lista flags del ambiente
#   bash scripts/toggle-flag.sh <env> <FLAG> [true|false] # cambia (sin valor = invierte)
set -euo pipefail
export MSYS_NO_PATHCONV=1

ENV="${1:?Uso: toggle-flag.sh <dev|test|prod> [FLAG] [true|false]}"
FLAG="${2:-}"
VALUE="${3:-}"
TABLE="aegisvolt-flags-${ENV}"

case "$ENV" in dev|test|prod) ;; *) echo "Ambiente inválido: $ENV" >&2; exit 1 ;; esac

if command -v aws >/dev/null 2>&1; then
  export AWS_ENDPOINT_URL="${AWS_ENDPOINT_URL:-http://localhost:4566}" AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-test}" \
         AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-test}" AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-us-east-1}"
  aws_() { aws "$@"; }
else
  aws_() { docker exec "${FLOCI_CONTAINER:-aegisvolt-floci}" aws --endpoint-url http://localhost:4566 "$@"; }
fi

if [ -z "$FLAG" ]; then
  aws_ dynamodb scan --table-name "$TABLE" \
    --query 'Items[].[name.S,enabled.BOOL,updatedBy.S,updatedAt.S]' --output table
  exit 0
fi

KEY="{\"PK\":{\"S\":\"FLAG#${FLAG}\"},\"SK\":{\"S\":\"META\"}}"
if [ -z "$VALUE" ]; then
  current=$(aws_ dynamodb get-item --table-name "$TABLE" --key "$KEY" --query 'Item.enabled.BOOL' --output text)
  [ "$current" = "None" ] && { echo "La flag $FLAG no existe en $TABLE" >&2; exit 1; }
  [ "$current" = "True" ] && VALUE=false || VALUE=true
fi
case "$VALUE" in true|false) ;; *) echo "Valor inválido: $VALUE" >&2; exit 1 ;; esac

now=$(date -u +%Y-%m-%dT%H:%M:%SZ)
aws_ dynamodb update-item --table-name "$TABLE" --key "$KEY" \
  --condition-expression "attribute_exists(PK)" \
  --update-expression "SET enabled = :v, updatedAt = :t, updatedBy = :u" \
  --expression-attribute-values "{\":v\":{\"BOOL\":${VALUE}},\":t\":{\"S\":\"${now}\"},\":u\":{\"S\":\"toggle-flag.sh\"}}" >/dev/null
echo "[$ENV] $FLAG = $VALUE"
