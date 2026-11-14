variable "env" {
  description = "Ambiente (dev|test|prod)."
  type        = string
}

variable "name_prefix" {
  description = "Prefijo de nombres."
  type        = string
}

variable "vpc_cidr" {
  description = "CIDR /16 de la VPC."
  type        = string

  validation {
    condition     = can(cidrhost(var.vpc_cidr, 0)) && endswith(var.vpc_cidr, "/16")
    error_message = "vpc_cidr debe ser un CIDR /16 válido."
  }
}

variable "availability_zones" {
  description = "Zonas de disponibilidad candidatas."
  type        = list(string)
  default     = ["us-east-1a", "us-east-1b", "us-east-1c"]
}

variable "az_count" {
  description = "Número de AZs a usar (subred pública + privada por AZ)."
  type        = number
  default     = 2
}
