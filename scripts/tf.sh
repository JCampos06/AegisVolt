#!/usr/bin/env bash
# Wrapper de Terraform: usa el binario local si existe; si no, la imagen oficial
# en Docker (versión fija) conectada a la red de docker-compose para hablar con Floci.
#
# Uso: bash scripts/tf.sh <dir> <args...>
#   bash scripts/tf.sh infra/bootstrap apply -auto-approve
#   bash scripts/tf.sh infra workspace select dev
set -euo pipefail

TF_VERSION="1.17.1"  # misma versión que el binario local
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIR="$1"; shift

if command -v terraform >/dev/null 2>&1; then
  export TF_VAR_aws_endpoint="${TF_VAR_aws_endpoint:-http://localhost:4566}"
  cd "$ROOT/$DIR" && exec terraform "$@"
fi

# Modo Docker: Floci se alcanza como http://floci:4566 dentro de la red del compose.
args=("$@")
if [ "${args[0]:-}" = "init" ] && [ "$DIR" = "infra" ]; then
  args+=("-backend-config=endpoints={s3=\"http://floci:4566\"}")
fi

MSYS_NO_PATHCONV=1 exec docker run --rm -i \
  --network aegisvolt_default \
  -v "$ROOT:/workspace" -w "/workspace/$DIR" \
  -v aegisvolt-tf-plugins:/root/.terraform.d/plugin-cache \
  -e TF_PLUGIN_CACHE_DIR=/root/.terraform.d/plugin-cache \
  -e TF_VAR_aws_endpoint=http://floci:4566 \
  -e TF_IN_AUTOMATION=1 \
  "hashicorp/terraform:${TF_VERSION}" "${args[@]}"
