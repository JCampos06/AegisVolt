#!/usr/bin/env bash
# Lista o restaura versiones anteriores del tfstate de un workspace.
#
#   bash scripts/restore-tfstate.sh <env>                 # lista versiones
#   bash scripts/restore-tfstate.sh <env> <version-id>    # restaura esa versión
#
# Restaurar = copiar la versión previa sobre la misma key (copy-object con
# VersionId). Esto crea una versión NUEVA idéntica a la antigua: el historial
# no se pierde, y la versión corrupta sigue disponible para auditoría.
set -euo pipefail

ENV="${1:?Uso: restore-tfstate.sh <dev|test|prod> [version-id]}"
VERSION="${2:-}"
BUCKET="${STATE_BUCKET:-aegisvolt-tfstate}"
KEY="env:/${ENV}/aegisvolt/terraform.tfstate"
CONTAINER="${FLOCI_CONTAINER:-aegisvolt-floci}"

case "$ENV" in dev|test|prod) ;; *) echo "Ambiente inválido: $ENV" >&2; exit 1 ;; esac

if command -v aws >/dev/null 2>&1; then
  aws_() { aws --endpoint-url "${AWS_ENDPOINT_URL:-http://localhost:4566}" "$@"; }
else
  aws_() { MSYS_NO_PATHCONV=1 docker exec "$CONTAINER" aws --endpoint-url http://localhost:4566 "$@"; }
fi

if [ -z "$VERSION" ]; then
  echo "Versiones de s3://$BUCKET/$KEY (más reciente primero):"
  aws_ s3api list-object-versions --bucket "$BUCKET" --prefix "$KEY" \
    --query "Versions[?Key=='$KEY'].[VersionId,IsLatest,LastModified,Size]" --output table
  exit 0
fi

echo "Restaurando $KEY a la versión $VERSION ..."
aws_ s3api copy-object --bucket "$BUCKET" --key "$KEY" \
  --copy-source "$BUCKET/$KEY?versionId=$VERSION" >/dev/null
echo "Listo. Verifique con:  bash scripts/tf.sh infra workspace select $ENV && bash scripts/tf.sh infra state list"
