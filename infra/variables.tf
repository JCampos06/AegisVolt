variable "region" {
  description = "Región AWS (emulada por Floci)."
  type        = string
  default     = "us-east-1"
}

variable "aws_endpoint" {
  description = "Endpoint de Floci para el provider AWS."
  type        = string
  default     = "http://localhost:4566"
}

variable "vpc_cidr" {
  description = "CIDR de la VPC del ambiente (distinto por ambiente para evitar solapamiento)."
  type        = string
}

variable "log_retention_days" {
  description = "Retención de los log groups de CloudWatch del ambiente."
  type        = number
}

variable "feature_flags" {
  description = "Estado INICIAL de las feature flags del ambiente. Los cambios posteriores se hacen en caliente en DynamoDB, sin redeploy."
  type        = map(bool)
}

variable "cors_allow_origins" {
  description = "Orígenes del frontend permitidos por API Gateway."
  type        = list(string)
}
