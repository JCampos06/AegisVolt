variable "env" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "feature_flags" {
  description = "Estado inicial de las feature flags del ambiente (nombre -> habilitada)."
  type        = map(bool)

  validation {
    condition = alltrue([
      for k in ["ENABLE_DYNAMIC_SURGE_PRICING", "ENABLE_FAST_CHARGE_BOOST", "SIMULATE_CHARGER_HARDWARE_FAULT"] :
      contains(keys(var.feature_flags), k)
    ])
    error_message = "Faltan flags obligatorias: ENABLE_DYNAMIC_SURGE_PRICING, ENABLE_FAST_CHARGE_BOOST, SIMULATE_CHARGER_HARDWARE_FAULT."
  }
}
