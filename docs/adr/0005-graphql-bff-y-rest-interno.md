# ADR-0005 — GraphQL como BFF y REST para la comunicación interna

- **Estado:** Aceptado
- **Fecha:** 2026-11-15

## Contexto
La UI necesita ver en una sola pantalla estaciones, conectores, saldo, tarifa, estado de la saga y flags. Además necesita actualizaciones en vivo: conectores, avance de la saga y cambios de flags.

Los microservicios son dueños de sus datos y no deben conocer las necesidades de la pantalla.

## Decisión
- **Hacia afuera, un único endpoint GraphQL** (Apollo Server 5 sobre Fastify): `POST /graphql` para queries y mutations, y `ws://…/graphql` (graphql-ws) para las subscriptions:
  - `sagaUpdated(correlationId)`: cada transición de la saga;
  - `connectorStatusChanged`: el gateway la publica al reservar o liberar un conector;
  - `flagChanged`: el gateway revisa la tabla de flags cada 5 s, así que también detecta los cambios hechos con `toggle-flag.sh`.
- **Hacia adentro, REST/JSON entre servicios** (ClusterIP en k8s), con contratos simples, `Idempotency-Key` y `x-correlation-id`.
- **El gateway no tiene reglas de negocio de los dominios.** El precio lo calcula billing, la regla de ultra-carga la aplica reservas y el fallo físico lo decide dispatch. El gateway compone respuestas y orquesta la saga ([ADR-0002](0002-saga-orquestada-en-gateway.md)).
- **Errores:** el código estable del servicio se expone en `extensions.code` (`INSUFFICIENT_FUNDS`, `CONNECTOR_UNAVAILABLE`, `FORBIDDEN`…). Un 404 se convierte en `null`.
- **`setFeatureFlag`:** se permite en dev y test. En prod exige el header `x-admin-token`, que se compara en tiempo constante. La introspección está apagada en prod.

## Alternativas consideradas
- **La UI llama directo a cada servicio por REST.** Genera N llamadas por pantalla, expone la topología interna y obliga a manejar CORS y autenticación en cada servicio.
- **gRPC interno.** Ofrece contratos tipados y mejor rendimiento, pero agrega generación de código y complica la depuración con curl en la demo. REST es suficiente para 3 llamadas por saga.

## Consecuencias
- **PubSub en memoria:** las subscriptions funcionan con **una réplica** del gateway. Con varias réplicas se necesitaría un bus compartido (Redis, EventBridge o DynamoDB Streams). Por eso el gateway corre con una réplica en cada ambiente.
- **Validación del esquema en CI** (día 5): `graphql-schema-linter` y `graphql-inspector` detectan cambios incompatibles.
