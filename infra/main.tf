# -----------------------------------------------------------------------------
# AegisVolt — raíz de infraestructura
#
# Un único código, tres ambientes aislados por Terraform Workspace:
#   terraform workspace select dev|test|prod
# Todo nombre de recurso incluye ${local.env} para evitar colisiones.
# Los módulos (network, vpc-endpoints, dynamodb, api-gateway, cloudwatch) se
# agregan en el Día 2.
# -----------------------------------------------------------------------------

locals {
  env          = terraform.workspace
  allowed_envs = ["dev", "test", "prod"]
  name_prefix  = "aegisvolt"

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
