# ADR-0003 — Idempotencia con escrituras condicionales en DynamoDB

- **Estado:** Aceptado
- **Fecha:** 2026-11-15

## Contexto
El orquestador SAGA (gateway) llama a los microservicios por REST. Para tolerar fallos transitorios, reintenta con backoff exponencial y jitter. Un reintento puede llegar dos veces aunque la primera llamada sí se haya aplicado, por ejemplo cuando hubo timeout pero el servicio sí respondió. Además, las compensaciones deben repetirse hasta que tengan éxito.

Sin idempotencia, un mismo `refund` devolvería el dinero dos veces y un `reserve` podría dejar un conector bloqueado para siempre. La especificación (pregunta 6.3) pide demostrar que el reembolso no se duplica.

## Decisión
- **Clave de idempotencia por paso:** `Idempotency-Key: <sagaId>:<step>` (`reserve`, `hold`, `activate`, `release`, `refund`, `stop`).
  - Sin el header, el servicio responde **400**.
  - Si el header no coincide con el `sagaId` del cuerpo, el servicio también responde **400**.
- **Un registro por saga y por servicio:**
  - `RESERVATION#<sagaId>`
  - `TX#<sagaId>`
  - `SESSION#<sagaId>`
- **Garantía en DynamoDB, no en memoria.** Cada efecto se aplica en una `TransactWriteItems` con `ConditionExpression`:
  - **reserve:** el conector pasa a `RESERVED` solo si `status = AVAILABLE`, y el registro de reserva se crea con `attribute_not_exists(PK)`.
  - **hold:** descuenta saldo con `balance >= :amt`, y crea `TX#<sagaId>` con `attribute_not_exists(SK)`.
  - **refund:** cambia `TX#<sagaId>` con `status = HELD` y suma el saldo en la misma transacción.
  - **release:** libera el conector solo si `sagaId = :saga AND status = RESERVED`.
  - **activate:** crea la sesión con `attribute_not_exists(PK)` y guarda el resultado, `ACTIVE` o `FAILED`.
- **Respuesta de un reintento:** devuelve el **resultado original** con `alreadyApplied: true` (200 en lugar de 201).
  - Si la transacción se cancela, el servicio vuelve a leer el registro para saber la causa: otra copia de la misma saga, falta de saldo (402) o conector ocupado (409).
- **Marca de compensación (*tombstone*).** Si la compensación llega antes que el paso, porque este quedó en vuelo o se perdió, el servicio deja el registro en estado `RELEASED`/`REFUNDED` con `tombstone: true`.
  - Si después llega el paso tardío, su escritura condicional falla y responde **409 `*_ALREADY_COMPENSATED`**.
  - Así no queda un cobro ni un bloqueo huérfano.
- **Errores de negocio sin reintento:** `INSUFFICIENT_FUNDS` (402), `CONNECTOR_UNAVAILABLE` (409) y `CHARGER_HARDWARE_FAULT` (422). Ante ellos el orquestador compensa de inmediato.
  - Solo se reintentan la red, los timeouts, 429 y 5xx (`packages/shared/src/http-client.ts`).

## Alternativas consideradas
- **Tabla genérica de idempotencia con la respuesta cacheada (patrón Stripe).** Agrega una escritura extra por llamada y no evita la carrera entre dos copias concurrentes si no se combina con condiciones. Las condiciones sobre el propio registro de negocio resuelven ambas cosas con una sola transacción.
- **Deduplicar en memoria.** No sobrevive a reinicios ni a varias réplicas del pod (canary 20/80).

## Consecuencias
- Pruebas contra DynamoDB real (Floci) en `services/*/test/*.int.test.ts`:
  - refund doble = un solo reembolso;
  - 5 reembolsos concurrentes = el saldo cambia una sola vez;
  - 5 retenciones concurrentes de la misma saga = un solo descuento;
  - 3 sagas compiten por un conector = una gana y las otras reciben 409;
  - una compensación anticipada bloquea el paso tardío.
- Cada servicio queda acoplado a las transacciones de DynamoDB. En otro motor habría que usar transacciones locales o el patrón *Outbox*.
- Las marcas de compensación ocupan espacio. En `reservations` pueden expirar con el TTL `expiresAt` cuando la saga ya está cerrada. En `billing` se conservan, porque el `TX#` funciona como registro contable.
