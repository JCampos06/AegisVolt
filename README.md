# AegisVolt

Plataforma cloud-native de gestión de carga para flotas de vehículos eléctricos y electrolineras B2B. Los operadores reservan bahías de carga, retienen saldo, activan sesiones de energía y auditan telemetría. La plataforma corre en tres ambientes aislados (`dev`, `test`, `prod`) con IaC, despliegues canary y consistencia eventual mediante SAGA.

> Proyecto Final — *Patrones Arquitectónicos Avanzados*, Universidad de La Sabana.

## Stack

| Capa | Tecnología |
|---|---|
| Nube (emulada) | [Floci](https://floci.io) 2.4.0: S3, DynamoDB, API Gateway, VPC/VPCE, CloudWatch |
| Kubernetes | kind (un namespace por ambiente) + Argo Rollouts (canary) + NGINX Ingress |
| IaC | Terraform 1.17 · backend S3 versionado · un workspace por ambiente |
| Backend | TypeScript / Node 24 · Apollo Server (GraphQL) · Fastify |
| Frontend | React + Vite + Apollo Client |
| Observabilidad | CloudWatch Logs (JSON con `correlation_id`) + Prefect 3 |
| CI/CD | GitHub Actions · Rulesets · flujo `feature → dev → test → prod` |

## Requisitos

Docker, kubectl, kind, Terraform ≥ 1.10, Node 24 + pnpm, AWS CLI v2 y Git Bash (en Windows).

> Sin Terraform ni AWS CLI instalados, `scripts/tf.sh` usa la imagen `hashicorp/terraform:1.17.1` y los scripts usan el AWS CLI incluido en el contenedor de Floci.

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
- [ADR-0002](docs/adr/0002-saga-orquestada-en-gateway.md) — SAGA orquestada dentro del gateway
- [ADR-0003](docs/adr/0003-idempotencia-escrituras-condicionales.md) — Idempotencia con escrituras condicionales en DynamoDB
- [ADR-0005](docs/adr/0005-graphql-bff-y-rest-interno.md) — GraphQL como BFF y REST interno
- [ADR-0007](docs/adr/0007-estado-terraform-s3-versionado-workspaces.md) — Estado en S3 versionado + workspaces
- [ADR-0008](docs/adr/0008-topologia-red-vpc-vpce.md) — Topología de red VPC / VPC Endpoints
- [ADR-0010](docs/adr/0010-rulesets-y-promotion-guard.md) — Rulesets + promotion-guard

Vista completa (red, datos y recorrido de un paquete): [docs/arquitectura.md](docs/arquitectura.md)

## Microservicios

| Servicio | Puerto | Tabla | Paso de la SAGA / compensación |
|---|---|---|---|
| `graphql-gateway` | 4000 | `aegisvolt-sagas-<env>` | Orquestador · `POST /graphql` y `ws://…/graphql` (subscriptions) |
| `station-reservation-service` | 4001 | `aegisvolt-reservations-<env>` | 1 `POST /reservations` · C1 `POST /reservations/:sagaId/release` |
| `billing-wallet-service` | 4002 | `aegisvolt-billing-<env>` | 2 `POST /holds` · C2 `POST /holds/:sagaId/refund` |
| `energy-dispatch-service` | 4003 | `aegisvolt-dispatch-<env>` | 3 `POST /sessions` (falla con `SIMULATE_CHARGER_HARDWARE_FAULT`) |

Todos exponen `/health`, que revisa DynamoDB, `/health/live` y `/metrics`. Los pasos exigen `Idempotency-Key: <sagaId>:<step>` y propagan `x-correlation-id`.

```bash
pnpm install
pnpm build && pnpm test          # compila y corre las pruebas unitarias
pnpm test:int                    # integración contra Floci (tablas efímeras), incluida la SAGA completa

# Un servicio contra las tablas de dev, con logs a CloudWatch
APP_ENV=dev AWS_ENDPOINT_URL=http://localhost:4566 CLOUDWATCH_LOGS_ENABLED=true \
  node services/billing-wallet-service/dist/server.js
```

> En Windows, para ver bien las tildes del AWS CLI: `export AWS_CLI_OUTPUT_ENCODING=UTF-8`.

## SAGA en docker compose

```bash
APP_ENV=test docker compose up -d --build      # Floci + gateway + 3 servicios sobre las tablas de test

bash scripts/demo-saga.sh test ok              # reserve -> hold -> activate = COMPLETED
bash scripts/demo-saga.sh test lowfunds        # hold 402 -> release = COMPENSATED
bash scripts/demo-saga.sh test fault           # flag de fallo -> refund -> release = COMPENSATED

bash scripts/trace-saga.sh <correlation_id> test   # la saga completa desde CloudWatch Logs
```

GraphQL: `http://localhost:4000/graphql`. La imagen de cada servicio sale del mismo [Dockerfile](Dockerfile) multi-stage (`--build-arg SERVICE=<servicio>`), con usuario no root, solo dependencias de producción y `HEALTHCHECK`.

## Feature flags (en caliente, sin redeploy)

```bash
bash scripts/toggle-flag.sh dev                                      # lista las flags de dev
bash scripts/toggle-flag.sh test SIMULATE_CHARGER_HARDWARE_FAULT true
```
