#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Despliega AegisVolt en el clúster kind (namespace aegisvolt-<env>).
#
#   bash scripts/k8s-deploy.sh <dev|test|prod> [opciones]
#
#   --faulty <servicio>   despliega <servicio> (uno de los 4 Node) con FAULTY_VERSION=true
#                         (~30% de 500) para la demo de rollback automático del canary
#   --tag <tag>           etiqueta de imagen (por defecto: git sha corto)
#   --no-wait             no espera a que terminen los canary
#
# Pasos: 1) Floci en la red kind  2) build + push de las imágenes :<tag> al registro
# local  3) genera k8s/.deploy/<env> (overlay + imagen + versión)  4) kubectl apply -k
# 5) espera cada Rollout: si Argo aborta el canary, el script falla (el rollback ya
# lo hizo Argo)  6) smoke test GraphQL por el Ingress.
# -----------------------------------------------------------------------------
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Servicios Node (Dockerfile de la raíz) + frontend (apps/frontend/Dockerfile).
NODE_SERVICES=(station-reservation-service billing-wallet-service energy-dispatch-service graphql-gateway)
SERVICES=("${NODE_SERVICES[@]}" frontend)
REGISTRY="${REGISTRY:-localhost:5001}"
CONTEXT="${KUBE_CONTEXT:-kind-aegisvolt}"
FLOCI_CONTAINER="${FLOCI_CONTAINER:-aegisvolt-floci}"
TIMEOUT="${ROLLOUT_TIMEOUT:-15m}"

usage() { sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

ENV="${1:-}"; shift || true
case "$ENV" in dev|test|prod) ;; *) usage ;; esac

FAULTY=""; TAG="${TAG:-}"; WAIT=1
while [ $# -gt 0 ]; do
  case "$1" in
    --faulty) FAULTY="${2:?falta el servicio}"; shift 2 ;;
    --tag) TAG="${2:?falta el tag}"; shift 2 ;;
    --no-wait) WAIT=0; shift ;;
    *) usage ;;
  esac
done
if [ -n "$FAULTY" ] && [[ ! " ${NODE_SERVICES[*]} " =~ \ $FAULTY\  ]]; then
  echo "Servicio desconocido para --faulty: $FAULTY (opciones: ${NODE_SERVICES[*]})"; exit 1
fi

# kubectl-argo-rollouts suele quedar en ~/.local/bin
command -v kubectl-argo-rollouts >/dev/null 2>&1 || export PATH="$PATH:$HOME/.local/bin"
for bin in docker kubectl kubectl-argo-rollouts git curl; do
  command -v "$bin" >/dev/null || { echo "Falta '$bin' en el PATH"; exit 1; }
done

NS="aegisvolt-$ENV"
K=(kubectl --context "$CONTEXT")

# Etiqueta inmutable: el commit. Con cambios sin commitear se marca -dirty-<epoch>
# para no reutilizar una etiqueta con contenido distinto.
if [ -z "$TAG" ]; then
  TAG="$(git rev-parse --short=12 HEAD)"
  if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
    TAG="$TAG-dirty-$(date +%s)"
  fi
fi

echo "==> Ambiente: $ENV  namespace: $NS  tag: $TAG${FAULTY:+  faulty: $FAULTY}"

# 1. Los pods llegan a Floci por la red docker "kind" (http://aegisvolt-floci:4566)
if ! docker network inspect kind -f '{{range .Containers}}{{.Name}} {{end}}' | grep -qw "$FLOCI_CONTAINER"; then
  echo "==> Conectando $FLOCI_CONTAINER a la red kind"
  docker network connect kind "$FLOCI_CONTAINER"
fi

# 2. Imágenes: solo se construyen si la etiqueta no existe aún en el registro
for svc in "${SERVICES[@]}"; do
  image="$REGISTRY/aegisvolt/$svc:$TAG"
  if curl -sf -o /dev/null -H 'Accept: application/vnd.docker.distribution.manifest.v2+json' \
      -H 'Accept: application/vnd.oci.image.index.v1+json' -H 'Accept: application/vnd.oci.image.manifest.v1+json' \
      "http://$REGISTRY/v2/aegisvolt/$svc/manifests/$TAG"; then
    echo "==> $image ya existe en el registro"
    continue
  fi
  echo "==> Build + push $image"
  if [ "$svc" = frontend ]; then
    docker build -q -f apps/frontend/Dockerfile --build-arg APP_VERSION="$TAG" -t "$image" . >/dev/null
  else
    docker build -q --build-arg SERVICE="$svc" --build-arg APP_VERSION="$TAG" -t "$image" . >/dev/null
  fi
  docker push -q "$image" >/dev/null
done

# 3. Overlay de despliegue generado (ignorado por git): overlay del ambiente +
#    imagen exacta + versión en etiqueta y APP_VERSION (dimensión Version de CloudWatch)
DEPLOY_DIR="k8s/.deploy/$ENV"
mkdir -p "$DEPLOY_DIR"
{
  echo "# Generado por scripts/k8s-deploy.sh — no editar ni versionar."
  echo "apiVersion: kustomize.config.k8s.io/v1beta1"
  echo "kind: Kustomization"
  echo "resources:"
  echo "  - ../../overlays/$ENV"
  echo "images:"
  for svc in "${SERVICES[@]}"; do
    echo "  - { name: aegisvolt/$svc, newName: $REGISTRY/aegisvolt/$svc, newTag: \"$TAG\" }"
  done
  echo "patches:"
  for svc in "${SERVICES[@]}"; do
    version="$TAG"; [ "$svc" = "$FAULTY" ] && version="$TAG-faulty"
    echo "  - target: { kind: Rollout, name: $svc }"
    echo "    patch: |-"
    echo "      - { op: replace, path: /metadata/labels/app.kubernetes.io~1version, value: \"$version\" }"
    echo "      - { op: add, path: /spec/template/metadata/labels/app.kubernetes.io~1version, value: \"$version\" }"
    echo "      - { op: replace, path: /spec/template/spec/containers/0/env/0/value, value: \"$version\" }"
    if [ "$svc" = "$FAULTY" ]; then
      echo "      - { op: add, path: /spec/template/spec/containers/0/env/-, value: { name: FAULTY_VERSION, value: \"true\" } }"
    fi
  done
} > "$DEPLOY_DIR/kustomization.yaml"

# Token admin del gateway (setFeatureFlag en prod). Nunca se versiona.
if [ -n "${ADMIN_TOKEN:-}" ]; then
  "${K[@]}" -n "$NS" create secret generic gateway-admin --from-literal=token="$ADMIN_TOKEN" \
    --dry-run=client -o yaml | "${K[@]}" apply -f - >/dev/null
elif [ "$ENV" = "prod" ] && ! "${K[@]}" -n "$NS" get secret gateway-admin >/dev/null 2>&1; then
  token="$(od -An -N24 -tx1 /dev/urandom | tr -d ' \n')"
  "${K[@]}" -n "$NS" create secret generic gateway-admin --from-literal=token="$token" >/dev/null
  echo "==> Creado el secret gateway-admin en $NS. Para leerlo:"
  echo "    kubectl -n $NS get secret gateway-admin -o jsonpath='{.data.token}' | base64 -d"
fi

# 4. Aplicar
echo "==> kubectl apply -k $DEPLOY_DIR"
# Reintento: el webhook de ingress-nginx valida cada Ingress contra su caché; si
# en el mismo apply un Ingress suelta una ruta y otro la toma (p. ej. "/" pasa del
# gateway al frontend), el primer intento puede rechazarse aunque el estado final sea válido.
for attempt in 1 2 3; do
  if "${K[@]}" apply -k "$DEPLOY_DIR"; then break; fi
  [ "$attempt" = 3 ] && { echo "==> kubectl apply falló 3 veces"; exit 1; }
  echo "    reintentando apply en 5 s ($attempt/3)..."; sleep 5
done

[ "$WAIT" = 1 ] || { echo "==> Sin esperar (--no-wait). Sigue el canary con:"; echo "    kubectl argo rollouts get rollout <servicio> -n $NS -w"; exit 0; }

# Un Rollout nuevo puede quedar un instante en InvalidSpec si se crea antes que el
# Ingress que referencia (stableIngress). Argo lo reevalúa al aparecer el Ingress;
# se espera a que se resuelva para que "rollouts status" no se rinda antes de tiempo.
for svc in "${SERVICES[@]}"; do
  for _ in $(seq 1 12); do
    msg="$("${K[@]}" -n "$NS" get rollout "$svc" -o jsonpath='{.status.message}' 2>/dev/null || true)"
    case "$msg" in
      InvalidSpec*)
        "${K[@]}" -n "$NS" annotate rollout "$svc" "aegisvolt/reconcile=$(date +%s)" --overwrite >/dev/null
        sleep 5 ;;
      *) break ;;
    esac
  done
done

# 5. Esperar los canary (corren en paralelo; los esperamos uno por uno)
echo "==> Esperando los Rollouts (timeout $TIMEOUT). En otra terminal:"
echo "    kubectl argo rollouts get rollout ${FAULTY:-graphql-gateway} -n $NS -w"
failed=()
for svc in "${SERVICES[@]}"; do
  if kubectl argo rollouts status "$svc" -n "$NS" --context "$CONTEXT" --timeout "$TIMEOUT"; then
    echo "    $svc: Healthy"
  else
    failed+=("$svc")
  fi
done

if [ ${#failed[@]} -gt 0 ]; then
  for svc in "${failed[@]}"; do
    echo "---- $svc ----"
    kubectl argo rollouts get rollout "$svc" -n "$NS" --context "$CONTEXT" || true
  done
  echo "==> Canary rechazado en: ${failed[*]}. Argo abortó y dejó la versión estable al 100%."
  exit 1
fi

# 6. Smoke test por el Ingress
bash "$ROOT/scripts/smoke-k8s.sh" "$ENV"
echo "==> Despliegue de $ENV OK ($TAG)"
