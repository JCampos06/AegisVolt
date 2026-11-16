# -----------------------------------------------------------------------------
# Datos semilla. `ignore_changes = [item]`: Terraform crea el ítem una sola vez
# y NO revierte los cambios hechos en caliente (toggle de flags, conectores
# reservados, saldos). Así `terraform apply` nunca pisa el estado de negocio.
# -----------------------------------------------------------------------------

locals {
  flag_descriptions = {
    ENABLE_DYNAMIC_SURGE_PRICING    = "Tarifa dinámica x1.5 en horas pico"
    ENABLE_FAST_CHARGE_BOOST        = "Habilita reserva prioritaria de conectores de ultra-carga (>=150 kW)"
    SIMULATE_CHARGER_HARDWARE_FAULT = "Inyección de fallo: el cargador falla en el paso 3 de la SAGA"
  }

  stations = {
    "BOG-01" = { name = "Electrolinera Calle 80", city = "Bogotá", lat = "4.6951", lon = "-74.0860" }
    "BOG-02" = { name = "Hub Logístico Fontibón", city = "Bogotá", lat = "4.6782", lon = "-74.1410" }
    "MDE-01" = { name = "Terminal Sur Medellín", city = "Medellín", lat = "6.2163", lon = "-75.5866" }
  }

  # power_kw >= 150 -> ultra-carga (solo reservable con ENABLE_FAST_CHARGE_BOOST)
  connectors = {
    "BOG-01#C1" = { station = "BOG-01", type = "CCS2", power_kw = 50 }
    "BOG-01#C2" = { station = "BOG-01", type = "CCS2", power_kw = 150 }
    "BOG-02#C1" = { station = "BOG-02", type = "CCS2", power_kw = 50 }
    "BOG-02#C2" = { station = "BOG-02", type = "CHAdeMO", power_kw = 50 }
    "BOG-02#C3" = { station = "BOG-02", type = "CCS2", power_kw = 350 }
    "MDE-01#C1" = { station = "MDE-01", type = "Type2", power_kw = 22 }
    "MDE-01#C2" = { station = "MDE-01", type = "CCS2", power_kw = 150 }
  }

  # FLEET-LOWFUNDS existe para demostrar la compensación del Paso 2 (fondos insuficientes).
  wallets = {
    "FLEET-NORTE-EV" = { name = "Flota Reparto Urbano Norte", balance = "500000" }
    "FLEET-ANDES-EV" = { name = "Logística Andes Eléctrica", balance = "250000" }
    "FLEET-LOWFUNDS" = { name = "Flota Saldo Bajo (demo)", balance = "1000" }
  }

  seed_ts = "2026-11-14T00:00:00Z"
}

resource "aws_dynamodb_table_item" "flags" {
  for_each = var.feature_flags

  table_name = aws_dynamodb_table.this["flags"].name
  hash_key   = "PK"
  range_key  = "SK"

  item = jsonencode({
    PK          = { S = "FLAG#${each.key}" }
    SK          = { S = "META" }
    name        = { S = each.key }
    enabled     = { BOOL = each.value }
    description = { S = lookup(local.flag_descriptions, each.key, "") }
    env         = { S = var.env }
    updatedAt   = { S = local.seed_ts }
    updatedBy   = { S = "terraform-seed" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

resource "aws_dynamodb_table_item" "stations" {
  for_each = local.stations

  table_name = aws_dynamodb_table.this["reservations"].name
  hash_key   = "PK"
  range_key  = "SK"

  item = jsonencode({
    PK   = { S = "STATION#${each.key}" }
    SK   = { S = "META" }
    name = { S = each.value.name }
    city = { S = each.value.city }
    lat  = { N = each.value.lat }
    lon  = { N = each.value.lon }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

resource "aws_dynamodb_table_item" "connectors" {
  for_each = local.connectors

  table_name = aws_dynamodb_table.this["reservations"].name
  hash_key   = "PK"
  range_key  = "SK"

  item = jsonencode({
    PK        = { S = "STATION#${each.value.station}" }
    SK        = { S = "CONNECTOR#${split("#", each.key)[1]}" }
    type      = { S = each.value.type }
    power_kw  = { N = tostring(each.value.power_kw) }
    status    = { S = "AVAILABLE" }
    version   = { N = "0" }
    updatedAt = { S = local.seed_ts }
  })

  lifecycle {
    ignore_changes = [item]
  }
}

resource "aws_dynamodb_table_item" "wallets" {
  for_each = local.wallets

  table_name = aws_dynamodb_table.this["billing"].name
  hash_key   = "PK"
  range_key  = "SK"

  item = jsonencode({
    PK       = { S = "WALLET#${each.key}" }
    SK       = { S = "META" }
    name     = { S = each.value.name }
    balance  = { N = each.value.balance }
    currency = { S = "COP" }
    version  = { N = "0" }
  })

  lifecycle {
    ignore_changes = [item]
  }
}
