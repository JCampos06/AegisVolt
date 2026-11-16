# ADR-0002 — SAGA orquestada dentro del `graphql-gateway`

- **Estado:** Aceptado
- **Fecha:** 2026-11-15

## Contexto
"Reservar y Activar Carga" toca tres bounded contexts, cada uno con su propia tabla (Database-per-Service):
1. reservar el conector (`station-reservation`);
2. retener el saldo (`billing-wallet`);
3. activar el cargador (`energy-dispatch`).

No existe una transacción ACID que abarque las tres tablas. Si un paso falla, hay que deshacer los anteriores con **compensaciones semánticas**, que no son un rollback.

La especificación exige demostrar dos rutas de fallo: fondos insuficientes y fallo físico. También exige ver la saga completa en los logs por `correlation_id`.

## Decisión
- **Orquestación, no coreografía.** Un orquestador (`services/graphql-gateway/src/saga/orchestrator.ts`) envía comandos REST síncronos a cada servicio y conoce el flujo completo.
- **El orquestador vive en el gateway** como módulo, no como un quinto servicio. Así hay un despliegue menos, y el gateway ya es el punto de entrada de la mutation `startChargingSession`.
- **Log persistente de la saga** en `aegisvolt-sagas-<env>`:
  - **write-ahead:** cada paso queda registrado como `STARTED` antes de llamarlo;
  - **bloqueo optimista** con `version`;
  - **GSI `status-updatedAt-index`** para que Prefect encuentre sagas huérfanas.
- **Tabla de decisión:**

  | Falla en | Error definitivo (4xx) | Resultado desconocido (timeout/5xx agotado) |
  |---|---|---|
  | 1 `reserve` | `FAILED` (no hay nada que compensar) | C1 `release` |
  | 2 `hold` (p. ej. 402) | C1 `release` | C2 `refund` → C1 `release` |
  | 3 `activate` (p. ej. 422) | C2 `refund` → C1 `release` | `stop` → C2 → C1 |

  Si el resultado es desconocido, también se compensa el paso que falló. Es seguro porque los servicios dejan una marca (ver [ADR-0003](0003-idempotencia-escrituras-condicionales.md)).
- **Reintentos:**
  - los pasos tienen 3 intentos y las compensaciones 6, con backoff exponencial y *full jitter*;
  - cada paso tiene un timeout de 2 s y cada compensación uno de 3 s.
- **Si una compensación agota sus intentos,** la saga queda en `COMPENSATING`. Se registra con nivel `error` y Prefect la detecta como huérfana.
- **`correlationId` = id de la saga.** Viaja en `x-correlation-id` y en `Idempotency-Key`. El cliente puede fijarlo, y así reenviar la mutation no crea otra saga.

## Alternativas consideradas
- **Coreografía por eventos** (cada servicio reacciona al evento del anterior). Da más autonomía, pero el flujo queda repartido entre los servicios y es difícil de auditar. Además exige un bus de eventos y el patrón Outbox, más infraestructura para un flujo lineal de 3 pasos.
- **Orquestador dedicado** (Temporal/Step Functions). Ofrece reanudación automática y un historial completo. Es una dependencia operativa más y no está disponible en Floci.

## Consecuencias
- **Evidencia:**
  - `bash scripts/demo-saga.sh <env> ok|lowfunds|fault` ejecuta cada ruta;
  - `bash scripts/trace-saga.sh <id> <env>` reconstruye la saga en CloudWatch, con los eventos de los 4 servicios ordenados por tiempo;
  - `tests/integration/saga.int.test.ts` prueba las 3 rutas con los servicios reales sobre Floci.
- **Llamadas síncronas:** la mutation responde con la saga ya terminada, en unos 150 ms en local. La UI sigue el avance paso a paso por la subscription `sagaUpdated`.
- **Riesgo de un gateway caído a mitad de saga:** la saga queda en `PENDING`, `RESERVED`, `CHARGED` o `COMPENSATING`, y el log write-ahead la deja visible. La reanudación automática es trabajo futuro; hoy Prefect la reporta.
- **Mezcla de responsabilidades:** el gateway concentra BFF y orquestación. Si el flujo creciera, el orquestador se extraería a su propio servicio sin cambiar los contratos REST.
