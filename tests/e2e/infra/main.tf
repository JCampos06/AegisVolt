# -----------------------------------------------------------------------------
# Infraestructura mínima para el job e2e-tests (CI): un Floci efímero recibe los
# MISMOS módulos de infra/ que usan dev/test/prod (tablas DynamoDB + semillas y
# log groups / metric filters de CloudWatch). Estado local: se descarta con el
# runner. No toca el estado remoto ni los ambientes reales.
#
#   terraform -chdir=tests/e2e/infra init
#   terraform -chdir=tests/e2e/infra apply -auto-approve
# -----------------------------------------------------------------------------
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.0"
    }
  }
}

variable "aws_endpoint" {
  type    = string
  default = "http://localhost:4566"
}

variable "env" {
  description = "Ambiente que simula el stack de docker compose (APP_ENV)."
  type        = string
  default     = "dev"
}

provider "aws" {
  region                      = "us-east-1"
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true

  endpoints {
    cloudwatch = var.aws_endpoint
    dynamodb   = var.aws_endpoint
    logs       = var.aws_endpoint
    sts        = var.aws_endpoint
  }
}

module "dynamodb" {
  source = "../../../infra/modules/dynamodb"

  env         = var.env
  name_prefix = "aegisvolt"
  feature_flags = {
    ENABLE_DYNAMIC_SURGE_PRICING    = true
    ENABLE_FAST_CHARGE_BOOST        = true
    SIMULATE_CHARGER_HARDWARE_FAULT = false
  }
}

module "cloudwatch" {
  source = "../../../infra/modules/cloudwatch"

  env            = var.env
  name_prefix    = "aegisvolt"
  retention_days = 1
  services       = ["graphql-gateway", "station-reservation-service", "billing-wallet-service", "energy-dispatch-service"]
}
