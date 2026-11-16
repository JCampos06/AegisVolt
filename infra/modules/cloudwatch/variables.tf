variable "env" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "services" {
  description = "Servicios que tienen log group propio."
  type        = list(string)

  validation {
    condition     = contains(var.services, "graphql-gateway")
    error_message = "La lista debe incluir graphql-gateway (métrica SagaCompensated)."
  }
}

variable "retention_days" {
  description = "Retención de logs en días."
  type        = number
}
