# ADR-0009 — Logging estructurado en JSON con `correlation_id`

- **Estado:** Aceptado
- **Fecha:** 2026-11-15

## Contexto
Una saga recorre 4 procesos: el gateway con el orquestador y los 3 servicios. Si falla, hay que poder reconstruir qué pasó en cada uno, en orden y sin mezclarlo con otras sagas ni con otros ambientes.

La especificación (sección 2.5) pide:
- logs **en JSON** con `correlation_id`, ambiente y microservicio;
- un log group de CloudWatch por ambiente: `/aegisvolt/<env>/...`;
- en la demo 6.4, **rastrear en CloudWatch el `correlation_id` de una saga fallida**.

## Decisión
- **Un logger común** (`packages/shared/src/logger.ts`, con pino). Cada línea es un objeto JSON con:

  | Campo | Origen |
  |---|---|
  | `timestamp` | ISO 8601 |
  | `level` | `info`, `warn` o `error` (texto, no número), para que los filtros sean legibles |
  | `env`, `service`, `version` | Campos base del proceso (`APP_ENV`, nombre del servicio, `APP_VERSION` = git sha) |
  | `correlation_id` | El id de la saga, que comparten todos los servicios |
  | `saga_step`, `saga_status` | `reserve`, `hold`, `activate`, `refund`, `release`, `stop`; `COMPENSATING`, `COMPENSATED` |
  | `message`, `error` | Texto del evento; el error serializado con su stack |
  | `method`, `route`, `statusCode`, `responseTimeMs` | Una línea por request al terminar (`onResponse`) |

- **Así viaja el `correlation_id`:**
  1. El gateway crea la saga con un `correlationId` (UUID). El cliente puede enviarlo para reintentar sin duplicar.
  2. Cada llamada REST del orquestador lleva el header `x-correlation-id`, más el `Idempotency-Key: <sagaId>:<step>` ([ADR-0003](0003-idempotencia-escrituras-condicionales.md)).
  3. En cada servicio, Fastify usa ese header como id del request (`genReqId`). Si no llega o no es válido, genera uno nuevo. Lo registra como `correlation_id` en todas las líneas del request y lo devuelve en la respuesta.
- **Dos destinos al mismo tiempo:**
  - **stdout**, para `kubectl logs`;
  - **CloudWatch Logs**, mediante un stream propio (`CloudWatchSink`) que envía lotes cada 2 s con `PutLogEvents` al log group `/aegisvolt/<env>/<servicio>`.

  Si CloudWatch no responde, el lote se descarta y se avisa una sola vez por stderr. **El servicio nunca se cae por no poder loguear.**
- **Log groups y métricas los crea Terraform** (`infra/modules/cloudwatch`), con retención por ambiente: dev 7 días, test 14 y prod 30. Los metric filters leen los campos JSON:
  - `ServiceErrors`: `$.level = "error"`;
  - `Http5xx`: `$.statusCode >= 500`, con dimensiones `Service` y `Version`, que usa el análisis del canary ([ADR-0006](0006-canary-argo-rollouts.md));
  - `SagaCompensated`: `$.saga_status = "COMPENSATED"`.
- **Rastreo:** `bash scripts/trace-saga.sh <correlation_id> <env>` busca el id en los 4 log groups del ambiente (`filter-log-events`) y muestra los eventos ordenados por tiempo.

## Alternativas consideradas
- **Texto plano** (`console.log`). Es más legible a simple vista, pero los metric filters de CloudWatch y Logs Insights necesitan campos, no expresiones regulares sobre texto.
- **OpenTelemetry con trazas distribuidas** (Jaeger o X-Ray). Es lo correcto para medir la latencia por tramo, pero agrega un collector y un backend de trazas en kind. El `correlation_id` en los logs cubre lo que se pide. Agregar OpenTelemetry después sería incremental, porque el header ya se propaga.
- **Fluent Bit como DaemonSet** para mandar stdout a CloudWatch. Es el patrón habitual en EKS, pero en kind con Floci son más piezas. Enviar desde el proceso es simple, aunque acopla el servicio al SDK de CloudWatch.
- **Usar el request id de cada servicio** sin propagarlo. Cada servicio tendría un id propio y no habría cómo unir los pasos de una misma saga.

## Consecuencias
- **Demo:** una saga compensada en `test` (flag de falla activada) devuelve un `correlationId`, que también se ve en la vista *Historial*. Con `bash scripts/trace-saga.sh <id> test` aparecen, en orden:
  - en el gateway: `reserve`, `hold`, `activate` (fallido), `refund` y `release`;
  - en los servicios: las líneas de cada uno, con el mismo id.

  Prefect cuenta las sagas compensadas por ambiente con la misma tabla de sagas.
- **La métrica del canary depende del formato del log.** Si se cambia el nombre de `statusCode`, el análisis `cloudwatch-5xx` deja de ver los errores. Un cambio de campos es un cambio de contrato.
- **Datos sensibles:** no se registran el token de administrador ni el cuerpo completo de los requests. El gateway solo registra el nombre de la operación GraphQL.
- **Pérdida tolerada:** si CloudWatch no está disponible, se pierden logs en CloudWatch, pero no en stdout. Es una decisión consciente: la disponibilidad del servicio está por encima de la completitud de los logs.
- **En AWS real:** el envío seguiría igual, a través del Interface VPCE de `logs` ([ADR-0008](0008-topologia-red-vpc-vpce.md)). También podría pasarse a Fluent Bit sin cambiar el formato.
