#!/usr/bin/env bash
# Crea el clúster kind "aegisvolt" + registro local de imágenes (localhost:5001)
# y los namespaces por ambiente. Idempotente: se puede ejecutar varias veces.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLUSTER=aegisvolt
REG_NAME=kind-registry
REG_PORT=5001

command -v kind >/dev/null || { echo "kind no está instalado (winget install Kubernetes.kind)"; exit 1; }
command -v kubectl >/dev/null || { echo "kubectl no está instalado"; exit 1; }

# 1. Registro local (imágenes etiquetadas con git-sha, nunca latest)
if [ "$(docker inspect -f '{{.State.Running}}' "$REG_NAME" 2>/dev/null || true)" != "true" ]; then
  docker run -d --restart=unless-stopped -p "127.0.0.1:${REG_PORT}:5000" --network bridge --name "$REG_NAME" registry:2.8.3
fi

# 2. Clúster
if ! kind get clusters | grep -qx "$CLUSTER"; then
  kind create cluster --config "$ROOT/k8s/kind-config.yaml"
fi

# 3. Los nodos resuelven localhost:5001 hacia el registro
for node in $(kind get nodes --name "$CLUSTER"); do
  docker exec "$node" mkdir -p "/etc/containerd/certs.d/localhost:${REG_PORT}"
  printf '[host."http://%s:5000"]\n' "$REG_NAME" | docker exec -i "$node" cp /dev/stdin "/etc/containerd/certs.d/localhost:${REG_PORT}/hosts.toml"
done
docker network connect kind "$REG_NAME" 2>/dev/null || true

# 4. Floci (docker compose) en la red "kind": los pods lo alcanzan como
#    http://aegisvolt-floci:4566 (ConfigMap aegisvolt-config). Si se recrea el
#    contenedor, scripts/k8s-deploy.sh lo vuelve a conectar.
if docker inspect aegisvolt-floci >/dev/null 2>&1; then
  docker network connect kind aegisvolt-floci 2>/dev/null || true
else
  echo "Aviso: aegisvolt-floci no existe todavía (docker compose up -d floci)"
fi

# 5. ingress-nginx (si ya está instalado): debe correr en el control-plane, que es
#    el único nodo con el puerto 80 publicado en localhost:8080 (kind-config.yaml).
if kubectl -n ingress-nginx get deployment ingress-nginx-controller >/dev/null 2>&1; then
  kubectl -n ingress-nginx patch deployment ingress-nginx-controller --type merge -p \
    '{"spec":{"template":{"spec":{"nodeSelector":{"kubernetes.io/os":"linux","ingress-ready":"true"},"tolerations":[{"key":"node-role.kubernetes.io/control-plane","operator":"Equal","effect":"NoSchedule"}]}}}}' >/dev/null
fi

# 6. Namespaces por ambiente
for env in dev test prod; do
  kubectl create namespace "aegisvolt-$env" --dry-run=client -o yaml | kubectl apply -f -
  kubectl label namespace "aegisvolt-$env" "aegisvolt/env=$env" --overwrite >/dev/null
done

echo "Clúster '$CLUSTER' listo. Registro: localhost:${REG_PORT}"
kubectl get nodes
kubectl get ns -l aegisvolt/env
