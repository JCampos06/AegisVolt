# ADR-0008 — Topología de red: VPC por ambiente, subredes privadas y VPC Endpoints

- **Estado:** Aceptado
- **Fecha:** 2026-11-14

## Contexto
La especificación pide una VPC dedicada por ambiente, con subredes públicas y privadas. El tráfico hacia API Gateway y Kubernetes debe ser privado, y el acceso a S3, DynamoDB y CloudWatch debe pasar por VPC Endpoints, sin salir a internet.

## Alternativas
| Opción | Ventajas | Desventajas |
|---|---|---|
| Subredes privadas + NAT Gateway | Los pods acceden a cualquier servicio | El tráfico a AWS pasa por NAT, que es más caro (~USD 32/mes por AZ más datos) y más expuesto. No cumple "evitar la internet pública" |
| **Subredes privadas sin NAT + VPC Endpoints** | El tráfico a AWS nunca sale de la red de AWS, con una superficie de ataque mínima | Cada servicio AWS nuevo necesita su propio endpoint |

## Decisión
- **Una VPC por ambiente** con CIDR sin solapamiento: dev `10.10.0.0/16`, test `10.20.0.0/16`, prod `10.30.0.0/16`. Se podrán unir con peering o Transit Gateway en el futuro sin tener que renumerar.
- **2 AZ**, cada una con una subred pública `/20` (índices 0–1) y una privada `/20` (índices 8–9).
- **Route table pública**: `0.0.0.0/0 → IGW`.
- **Route table privada**: solo la ruta `local` y las prefix lists de los Gateway VPCE. **No tiene ruta a internet.**
- **Gateway VPCE** para S3 y DynamoDB. El de DynamoDB tiene una **política que solo permite `aegisvolt-*-<env>`**: un pod de dev no puede escribir en una tabla de prod aunque tenga credenciales.
- **Interface VPCE** para `logs`, `monitoring`, `execute-api` y `sts`, con DNS privado y SG que solo admite 443 desde la VPC.
- **Entrada**: API Gateway HTTP API → **VPC Link** → **NLB interno** → NGINX Ingress → pod.
- **Security Groups encadenados**: `sg-vpclink` (egress 80 hacia la VPC) → `sg-k8s-nodes` (ingress 80 **solo desde `sg-vpclink`**) → `sg-vpce` (443 desde la VPC).

## Consecuencias
- El NLB no tiene IP pública: la única forma de llegar al clúster desde fuera es API Gateway.
- En Floci, la VPC, los VPCE, el VPC Link y el NLB existen como recursos reales en el estado de Terraform, pero no hay enrutamiento físico. El tráfico real de la demo ocurre dentro de kind (ADR-0001). El recorrido completo está en `docs/arquitectura.md`.
- `execute-api` como Interface VPCE permite invocar APIs **REST privadas** desde la VPC. La API HTTP pública usa el VPC Link para el tramo de entrada.

## Condición de revisión
Si un servicio necesita acceder a internet (por ejemplo, una API externa de tarifas eléctricas), se agrega un NAT Gateway solo para esa subred, documentado en un ADR nuevo.
