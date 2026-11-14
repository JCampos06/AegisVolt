# AegisVolt

Plataforma cloud-native de gestión de carga para flotas de vehículos eléctricos y electrolineras B2B. Los operadores reservan bahías de carga, retienen saldo, activan sesiones de energía y auditan telemetría. La plataforma corre en tres ambientes aislados (`dev`, `test`, `prod`) con IaC, despliegues canary y consistencia eventual mediante SAGA.

> Proyecto Final — *Patrones Arquitectónicos Avanzados*, Universidad de La Sabana.

## Stack

| Capa | Tecnología |
|---|---|
| Nube (emulada) | [Floci](https://floci.io) 2.4.0: S3, DynamoDB, API Gateway, VPC/VPCE, CloudWatch |
| Kubernetes | kind (un namespace por ambiente) + Argo Rollouts (canary) + NGINX Ingress |
| IaC | Terraform 1.14 · backend S3 versionado · un workspace por ambiente |
| Backend | TypeScript / Node 24 · Apollo Server (GraphQL) · Fastify |
| Frontend | React + Vite + Apollo Client |
| Observabilidad | CloudWatch Logs (JSON con `correlation_id`) + Prefect 3 |
| CI/CD | GitHub Actions · Rulesets · flujo `feature → dev → test → prod` |

## Requisitos

Docker, kubectl, kind, Terraform ≥ 1.10, Node 24 + pnpm, AWS CLI v2 y Git Bash (en Windows).

> Sin Terraform ni AWS CLI instalados, `scripts/tf.sh` usa la imagen `hashicorp/terraform:1.14.0` y los scripts usan el AWS CLI incluido en el contenedor de Floci.

## Inicio rápido

```bash
# 1. Emulador AWS
docker compose up -d floci
bash scripts/verify-floci.sh              # 23/23 OK esperado

# 2. Bucket de estados (una sola vez)
bash scripts/tf.sh infra/bootstrap init
bash scripts/tf.sh infra/bootstrap apply -auto-approve

# 3. Infraestructura por ambiente
bash scripts/tf.sh infra init
bash scripts/tf.sh infra workspace select dev     # o: workspace new dev
bash scripts/tf.sh infra apply -var-file=env/dev.tfvars

# 4. Kubernetes local
bash scripts/kind-up.sh
```

## Estado de Terraform

```bash
bash scripts/restore-tfstate.sh dev                 # lista las versiones del tfstate de dev
bash scripts/restore-tfstate.sh dev <version-id>    # restaura una versión previa
```

## Estructura

```
apps/frontend/          UI React
services/               graphql-gateway (+ orquestador SAGA) y los 3 microservicios
packages/shared/        logger, correlation-id, feature flags, idempotencia
infra/                  Terraform (bootstrap/, módulos, env/*.tfvars)
k8s/                    kind, Kustomize base/overlays, Argo Rollouts
observability/prefect/  flows de salud y auditoría SAGA
scripts/                utilidades (verificación, tfstate, kind, demos)
docs/adr/               decisiones de arquitectura
.github/                workflows y ruleset de protección de ramas
```

## Decisiones de arquitectura

- [ADR-0001](docs/adr/0001-floci-kind-como-nube-local.md) — Floci + kind como plataforma de ejecución
- [ADR-0007](docs/adr/0007-estado-terraform-s3-versionado-workspaces.md) — Estado en S3 versionado + workspaces
- [ADR-0010](docs/adr/0010-rulesets-y-promotion-guard.md) — Rulesets + promotion-guard
