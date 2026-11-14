# -----------------------------------------------------------------------------
# AegisVolt — raíz de infraestructura
#
# Un único código, tres ambientes aislados por Terraform Workspace:
#   terraform workspace select dev|test|prod
# Todo nombre de recurso incluye ${local.env} para evitar colisiones.
# -----------------------------------------------------------------------------

locals {
  env          = terraform.workspace
  allowed_envs = ["dev", "test", "prod"]
  name_prefix  = "aegisvolt"

  services = [
    "graphql-gateway",
    "station-reservation-service",
    "billing-wallet-service",
    "energy-dispatch-service",
  ]

  common_tags = {
    Project     = "aegisvolt"
    Environment = local.env
    ManagedBy   = "terraform"
  }
}

# Guardia: aborta plan/apply si se está en el workspace "default" o en uno
# desconocido. Impide crear recursos fuera de dev/test/prod por error.
resource "terraform_data" "workspace_guard" {
  input = local.env

  lifecycle {
    precondition {
      condition     = contains(local.allowed_envs, terraform.workspace)
      error_message = "Workspace inválido: '${terraform.workspace}'. Use: terraform workspace select dev|test|prod"
    }
  }
}

# --- Red ---------------------------------------------------------------------

module "network" {
  source = "./modules/network"

  env         = local.env
  name_prefix = local.name_prefix
  vpc_cidr    = var.vpc_cidr
}

module "vpc_endpoints" {
  source = "./modules/vpc-endpoints"

  env                     = local.env
  name_prefix             = local.name_prefix
  vpc_id                  = module.network.vpc_id
  private_subnet_ids      = module.network.private_subnet_ids
  private_route_table_ids = [module.network.private_route_table_id]
  sg_vpc_endpoints_id     = module.network.sg_vpc_endpoints_id
}

# --- Persistencia (Database-per-Service) ------------------------------------

module "dynamodb" {
  source = "./modules/dynamodb"

  env           = local.env
  name_prefix   = local.name_prefix
  feature_flags = var.feature_flags
}

# --- Observabilidad ----------------------------------------------------------

module "cloudwatch" {
  source = "./modules/cloudwatch"

  env            = local.env
  name_prefix    = local.name_prefix
  services       = local.services
  retention_days = var.log_retention_days
}

# --- Entrada pública ---------------------------------------------------------

module "api_gateway" {
  source = "./modules/api-gateway"

  env                = local.env
  name_prefix        = local.name_prefix
  vpc_id             = module.network.vpc_id
  private_subnet_ids = module.network.private_subnet_ids
  sg_vpc_link_id     = module.network.sg_vpc_link_id
  cors_allow_origins = var.cors_allow_origins
  log_retention_days = var.log_retention_days
}
