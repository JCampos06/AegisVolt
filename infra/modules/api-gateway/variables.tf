variable "env" {
  type = string
}

variable "name_prefix" {
  type = string
}

variable "vpc_id" {
  type = string
}

variable "private_subnet_ids" {
  description = "Subredes privadas para el NLB interno y las ENIs del VPC Link."
  type        = list(string)
}

variable "sg_vpc_link_id" {
  type = string
}

variable "cors_allow_origins" {
  description = "Orígenes permitidos (frontend del ambiente)."
  type        = list(string)
}

variable "log_retention_days" {
  type = number
}

variable "throttling_burst_limit" {
  type    = number
  default = 100
}

variable "throttling_rate_limit" {
  type    = number
  default = 50
}
