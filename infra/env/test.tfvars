vpc_cidr           = "10.20.0.0/16"
log_retention_days = 14
cors_allow_origins = ["http://test.aegisvolt.localhost:8080"]

feature_flags = {
  ENABLE_DYNAMIC_SURGE_PRICING    = true
  ENABLE_FAST_CHARGE_BOOST        = false
  SIMULATE_CHARGER_HARDWARE_FAULT = false
}
