# -----------------------------------------------------------------------------
# Bootstrap del estado remoto de AegisVolt
#
# Problema "huevo-gallina": el bucket que guarda los tfstate no puede guardarse
# a sí mismo. Este módulo usa estado LOCAL y se ejecuta una sola vez.
# Todo lo demás (infra/) usa el backend S3 que se crea aquí.
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

provider "aws" {
  region                      = var.region
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  endpoints {
    s3  = var.aws_endpoint
    sts = var.aws_endpoint
  }

  default_tags {
    tags = {
      Project   = "aegisvolt"
      ManagedBy = "terraform"
      Component = "tfstate-bootstrap"
    }
  }
}

resource "aws_s3_bucket" "tfstate" {
  bucket = var.state_bucket_name

  # El bucket de estados nunca debe destruirse accidentalmente.
  lifecycle {
    prevent_destroy = true
  }
}

# Requisito del proyecto: Versioning Enabled -> cada escritura del tfstate
# genera una versión nueva y se puede restaurar cualquier versión previa.
resource "aws_s3_bucket_versioning" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "tfstate" {
  bucket = aws_s3_bucket.tfstate.id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}

resource "aws_s3_bucket_public_access_block" "tfstate" {
  bucket                  = aws_s3_bucket.tfstate.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

# Conserva las versiones antiguas del estado durante N días (auditoría/backups).
resource "aws_s3_bucket_lifecycle_configuration" "tfstate" {
  bucket     = aws_s3_bucket.tfstate.id
  depends_on = [aws_s3_bucket_versioning.tfstate]

  rule {
    id     = "retain-noncurrent-state-versions"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.noncurrent_version_retention_days
    }
  }
}
