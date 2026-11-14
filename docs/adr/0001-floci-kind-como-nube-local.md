# ADR-0001 — Floci + kind como plataforma de ejecución

- **Estado:** Aceptado
- **Fecha:** 2026-11-14

## Contexto
AegisVolt necesita tres ambientes aislados (`dev`, `test`, `prod`). Cada uno lleva VPC, VPC Endpoints, API Gateway, DynamoDB, CloudWatch y un clúster de Kubernetes. El proyecto es individual, dura 7 días y no tiene presupuesto. La especificación permite usar AWS real o un emulador compatible como Floci.

## Alternativas
| Opción | Ventajas | Desventajas |
|---|---|---|
| AWS real (EKS ×3) | Red real y máximo realismo | ≈ USD 10–20 al día (EKS, NAT, Interface VPCE). Hay que destruir y recrear a diario, y una factura olvidada es un riesgo |
| LocalStack Community | Herramienta conocida | EKS y varias funciones avanzadas solo están en la versión Pro |
| **Floci + kind** | Gratis y de código abierto (MIT). Emula S3 con versionamiento, DynamoDB, APIGW v1/v2 con VPC Link, EC2/VPC con VPCE, CloudWatch Logs y Metrics, e IAM/STS. kind da un Kubernetes real | La red de la VPC se emula como metadatos: los recursos existen, pero no hay enrutamiento físico |

## Decisión
- **Floci 2.4.0** (imagen `floci/floci:2.4.0-compat`, versión fija) emula los servicios AWS en `localhost:4566`, con persistencia en disco (`FLOCI_STORAGE_MODE=persistent`).
- **kind** da el clúster de Kubernetes real, con un namespace por ambiente (`aegisvolt-dev|test|prod`) y un registro local en `localhost:5001`.

## Validación (Día 1)
`scripts/verify-floci.sh` dio **23/23 OK**:
- STS e IAM.
- S3 con versionamiento: 2 versiones del mismo objeto.
- DynamoDB con `ConditionalCheckFailed` en una escritura duplicada (la base de la idempotencia).
- VPC, subred, tabla de rutas y security group.
- Los 4 VPCE: Gateway para S3 y DynamoDB, Interface para `logs` y `execute-api`.
- API Gateway v2 y VPC Link.
- CloudWatch Logs con búsqueda por `correlation_id`, y Metrics.

La persistencia se comprobó reiniciando el contenedor: las versiones del tfstate se conservaron.

## Consecuencias
- Costo $0, ambiente reproducible con `docker compose up`.
- En la defensa hay que **distinguir lo implementado de lo emulado**. Los VPCE y el VPC Link se declaran en Terraform y existen en el estado, pero el recorrido de red físico se explica como funcionaría en AWS (ver `docs/arquitectura.md`).
- El pipeline de deploy necesita un *self-hosted runner* en la máquina donde corren Floci y kind (ver ADR-0010).

## Condición de revisión
Se revisa si el proyecto pasa a AWS real. Bastaría con cambiar `aws_endpoint` y el backend, porque los módulos de Terraform no cambian.
