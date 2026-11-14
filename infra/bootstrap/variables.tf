variable "region" {
  description = "Región AWS (emulada por Floci)."
  type        = string
  default     = "us-east-1"
}

variable "aws_endpoint" {
  description = "Endpoint de Floci. http://localhost:4566 desde el host; http://floci:4566 desde la red de docker-compose."
  type        = string
  default     = "http://localhost:4566"
}

variable "state_bucket_name" {
  description = "Bucket S3 que almacena los tfstate de todos los workspaces."
  type        = string
  default     = "aegisvolt-tfstate"
}

variable "noncurrent_version_retention_days" {
  description = "Días que se conservan las versiones anteriores del tfstate."
  type        = number
  default     = 90
}
