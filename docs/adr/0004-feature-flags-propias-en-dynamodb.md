# ADR-0004 — Feature flags propias en DynamoDB, una tabla por ambiente

- **Estado:** Aceptado
- **Fecha:** 2026-11-15

## Contexto
La especificación pide feature flags con **estado independiente por ambiente** (`dev`, `test` y `prod`) y tres flags concretas:

| Flag | Qué hace | Quién la lee |
|---|---|---|
| `ENABLE_DYNAMIC_SURGE_PRICING` | Tarifa de hora pico (multiplicador ×1.5) | `billing-wallet-service` al cotizar y al retener saldo |
| `ENABLE_FAST_CHARGE_BOOST` | Permite reservar conectores de ultra-carga (≥ 150 kW) | `station-reservation-service`, al listar (campo `reservable`) y al reservar |
| `SIMULATE_CHARGER_HARDWARE_FAULT` | Hace fallar la activación física para demostrar la compensación de la SAGA | `energy-dispatch-service` en el paso `activate` |

Además, la demo 6.4 pide **cambiar una flag en `dev` sin redesplegar** y ver que la UI de `dev` cambia mientras `prod` sigue igual.

## Decisión
- **Una tabla por ambiente:** `aegisvolt-flags-<env>`, creada por el módulo `infra/modules/dynamodb` con `${terraform.workspace}`. Cada ítem es `PK=FLAG#<nombre>`, `SK=META`, con `enabled`, `description`, `updatedAt` y `updatedBy`.
  - El aislamiento entre ambientes es físico: son tablas distintas. La política del VPCE de DynamoDB solo permite `aegisvolt-*-<env>` ([ADR-0008](0008-topologia-red-vpc-vpce.md)).
- **Semilla por `tfvars`, con `ignore_changes = [item]`:** Terraform crea cada flag una sola vez con el valor de `infra/env/<env>.tfvars`.

  | Flag | dev | test | prod |
  |---|---|---|---|
  | `ENABLE_DYNAMIC_SURGE_PRICING` | `true` | `true` | `false` |
  | `ENABLE_FAST_CHARGE_BOOST` | `true` | `false` | `false` |
  | `SIMULATE_CHARGER_HARDWARE_FAULT` | `false` | `false` | `false` |

  Después Terraform no vuelve a tocar las flags. Si no fuera así, cada `terraform apply` del pipeline devolvería al valor inicial una flag que alguien cambió en caliente.
- **Cliente compartido** (`packages/shared/src/flags.ts`): `FeatureFlags.isEnabled(nombre)`.
  - Lee la tabla con **caché de 5 s** (`ConsistentRead`) y comparte la petición en curso, así que muchas lecturas simultáneas hacen un solo `Scan`.
  - **Falla segura:** si DynamoDB no responde, usa el último valor conocido. Si nunca lo leyó, la flag cuenta como **apagada**, lo que significa sin recargo, sin ultra-carga y sin falla simulada.
- **Cada servicio lee la flag que le corresponde** directamente de la tabla de su ambiente, en el momento de decidir. El gateway no reenvía flags a los servicios.
- **Dos formas de cambiarlas sin redeploy:**
  1. **Mutation `setFeatureFlag(name, enabled)`**, que usa la vista *Flags* de la UI. Es un `UpdateItem` con `attribute_exists(PK)`, así que no se pueden crear flags nuevas desde la API. En **`prod`** exige el header `x-admin-token`; el token vive en el secret de Kubernetes `gateway-admin` y en ningún archivo versionado.
  2. **`scripts/toggle-flag.sh <env> <FLAG> [true|false]`**, que escribe directo en la tabla, como lo haría un operador.
- **Propagación a la UI:** el `FlagWatcher` del gateway revisa la tabla cada 5 s y publica la subscription `flagChanged`. La UI se entera aunque el cambio venga del script.

## Alternativas consideradas
- **AWS AppConfig.** Es el servicio gestionado de AWS para esto, con validadores y despliegue gradual de la configuración. Floci no lo emula con la fidelidad necesaria, y la especificación acepta flags propias en DynamoDB.
- **Unleash o Flagsmith.** Dan una UI, segmentos y porcentajes de usuarios, pero agregan otro servidor y otra base de datos por ambiente dentro de kind. Para 3 flags booleanas es demasiado.
- **Variables de entorno o ConfigMap.** Son simples, pero cambiar una exige reiniciar los pods, y la demo pide "sin redesplegar".
- **Una sola tabla con el ambiente en la clave.** Ahorra tablas, pero un error en la clave podría cambiar `prod` desde `dev`, y la política del VPCE ya no podría aislar por nombre de tabla.

## Consecuencias
- **Demo en vivo:** `bash scripts/toggle-flag.sh dev ENABLE_DYNAMIC_SURGE_PRICING false`. En unos 5 s la vista *Cargar* de `dev` muestra el precio sin recargo, y `prod` sigue igual.
- **Demo de la SAGA:** se activa `SIMULATE_CHARGER_HARDWARE_FAULT` en `test`, `activate` falla con 422 y el orquestador compensa con `refund` y `release` ([ADR-0002](0002-saga-orquestada-en-gateway.md)).
- **Consistencia eventual de hasta 5 s:** durante esa ventana, dos servicios pueden ver valores distintos de la misma flag. Ninguna flag cruza servicios en una misma decisión, así que no genera estados inválidos.
- **Sin auditoría completa:** solo se guarda el último cambio (`updatedAt` y `updatedBy`), y el log de cada cambio queda en CloudWatch. Para un historial completo habría que activar DynamoDB Streams.
- **En AWS real** se mantiene el diseño. Las credenciales pasan a IRSA, con permiso de solo lectura sobre la tabla para los servicios y de escritura solo para el gateway.
