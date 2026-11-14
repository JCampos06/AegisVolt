# ADR-0007 — Estado de Terraform en S3 versionado + un Workspace por ambiente

- **Estado:** Aceptado
- **Fecha:** 2026-11-14

## Contexto
Los tres ambientes comparten el mismo código de Terraform. Un `apply` en un ambiente no debe poder modificar el estado ni los recursos de otro. Además, el estado debe tener backups históricos para casos de corrupción o auditoría.

## Alternativas
| Opción | Ventajas | Desventajas |
|---|---|---|
| Directorio por ambiente (`envs/dev`, ...) | Aislamiento explícito | Código duplicado y riesgo de divergencia. La especificación exige workspaces |
| **Workspaces + backend S3** | Un solo código y un estado separado por workspace en S3 | Hay que proteger contra el uso del workspace `default` |

## Decisión
1. `infra/bootstrap/` (con estado **local**) crea el bucket `aegisvolt-tfstate` con:
   - **Versioning = Enabled**;
   - cifrado SSE AES256;
   - bloqueo de acceso público;
   - retención de 90 días para las versiones no actuales;
   - `prevent_destroy`.
2. `infra/backend.tf` usa `workspace_key_prefix = "env:"`. Cada ambiente queda en un objeto distinto:
   - `env:/dev/aegisvolt/terraform.tfstate`
   - `env:/test/aegisvolt/terraform.tfstate`
   - `env:/prod/aegisvolt/terraform.tfstate`
3. **Locking nativo de S3** (`use_lockfile = true`, Terraform ≥ 1.10). Usa un archivo `.tflock` y no necesita tabla DynamoDB.
4. `local.env = terraform.workspace`. Todos los nombres de recurso incluyen el ambiente, por ejemplo `aegisvolt-billing-test`.
5. **Guardia**: una `precondition` aborta `plan`/`apply` si el workspace no es `dev`, `test` ni `prod`.
6. Los valores por ambiente están en `infra/env/<env>.tfvars`.

## Por qué `apply` en `test` no puede tocar `prod`
- **Estado:** Terraform solo lee y escribe `env:/test/...`. El estado de prod es otro objeto S3.
- **Recursos:** todos los nombres se derivan de `terraform.workspace`, así que los recursos de test no coinciden con los de prod.
- **Pipeline:** el workspace se elige a partir de la rama destino (ADR-0010).

## Restauración de un estado corrupto
`scripts/restore-tfstate.sh <env>` lista las versiones disponibles. `scripts/restore-tfstate.sh <env> <version-id>` hace `copy-object` de esa versión sobre la key actual. Esto crea una versión nueva y conserva la corrupta para auditoría. Probado el Día 1: después de restaurar, `terraform plan` responde *No changes*.

## Consecuencias
- El bootstrap es el único estado local. Se puede recrear porque el bucket es idempotente.
- Las versiones del `.tflock` también aparecen en el historial. Es esperado.
