vpc_cidr           = "10.30.0.0/16"
log_retention_days = 30
cors_allow_origins = ["http://prod.aegisvolt.localhost:8080"]

feature_flags = {
  ENABLE_DYNAMIC_SURGE_PRICING    = false
  ENABLE_FAST_CHARGE_BOOST        = false
  SIMULATE_CHARGER_HARDWARE_FAULT = false
}
