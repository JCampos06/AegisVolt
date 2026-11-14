vpc_cidr           = "10.10.0.0/16"
log_retention_days = 7
cors_allow_origins = ["http://localhost:5173", "http://dev.aegisvolt.localhost:8080"]

feature_flags = {
  ENABLE_DYNAMIC_SURGE_PRICING    = true
  ENABLE_FAST_CHARGE_BOOST        = true
  SIMULATE_CHARGER_HARDWARE_FAULT = false
}
