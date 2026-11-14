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
  description = "Subredes privadas donde se crean las ENIs de los Interface VPCE."
  type        = list(string)
}

variable "private_route_table_ids" {
  description = "Route tables privadas asociadas a los Gateway VPCE."
  type        = list(string)
}

variable "sg_vpc_endpoints_id" {
  description = "Security group de los Interface VPCE (443 desde la VPC)."
  type        = string
}
