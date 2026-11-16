# -----------------------------------------------------------------------------
# Módulo dynamodb: patrón Database-per-Service, separado por ambiente.
#
#   aegisvolt-reservations-<env>  -> station-reservation-service
#   aegisvolt-billing-<env>       -> billing-wallet-service
#   aegisvolt-dispatch-<env>      -> energy-dispatch-service
#   aegisvolt-sagas-<env>         -> graphql-gateway (log del orquestador SAGA)
#   aegisvolt-flags-<env>         -> feature flags del ambiente
#
# Todas usan clave compuesta genérica (PK, SK) -> single-table design por servicio.
# -----------------------------------------------------------------------------

locals {
  tables = {
    reservations = { owner = "station-reservation-service", ttl = true }
    billing      = { owner = "billing-wallet-service", ttl = false }
    dispatch     = { owner = "energy-dispatch-service", ttl = true }
    sagas        = { owner = "graphql-gateway", ttl = false }
    flags        = { owner = "feature-flags", ttl = false }
  }
  is_prod = var.env == "prod"
}

resource "aws_dynamodb_table" "this" {
  for_each = local.tables

  name         = "${var.name_prefix}-${each.key}-${var.env}"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "PK"
  range_key    = "SK"

  # prod: no se puede borrar la tabla ni por `terraform destroy` accidental.
  deletion_protection_enabled = local.is_prod

  attribute {
    name = "PK"
    type = "S"
  }

  attribute {
    name = "SK"
    type = "S"
  }

  # Solo la tabla de sagas: índice para que Prefect encuentre sagas huérfanas
  # (status = PENDING/COMPENSATING con updatedAt antiguo) sin hacer Scan.
  dynamic "attribute" {
    for_each = each.key == "sagas" ? ["status", "updatedAt"] : []
    content {
      name = attribute.value
      type = "S"
    }
  }

  dynamic "global_secondary_index" {
    for_each = each.key == "sagas" ? [1] : []
    content {
      name            = "status-updatedAt-index"
      hash_key        = "status"
      range_key       = "updatedAt"
      projection_type = "ALL"
    }
  }

  # Bloqueos temporales de conectores y telemetría expiran solos.
  dynamic "ttl" {
    for_each = each.value.ttl ? [1] : []
    content {
      attribute_name = "expiresAt"
      enabled        = true
    }
  }

  point_in_time_recovery {
    enabled = local.is_prod
  }

  tags = {
    Name    = "${var.name_prefix}-${each.key}-${var.env}"
    Service = each.value.owner
  }
}
