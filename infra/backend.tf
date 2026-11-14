# -----------------------------------------------------------------------------
# Backend remoto S3 (bucket versionado creado por infra/bootstrap).
#
# Con workspaces, Terraform guarda cada estado en:
#   s3://aegisvolt-tfstate/env:/<workspace>/aegisvolt/terraform.tfstate
#   -> env:/dev/...  env:/test/...  env:/prod/...
# Así un `apply` en test jamás toca el estado de prod: son objetos S3 distintos.
#
# El endpoint se puede sobreescribir en `terraform init` con
#   -backend-config='endpoints={s3="http://floci:4566"}'
# -----------------------------------------------------------------------------

terraform {
  backend "s3" {
    bucket               = "aegisvolt-tfstate"
    key                  = "aegisvolt/terraform.tfstate"
    workspace_key_prefix = "env:" # valor por defecto de Terraform -> env:/<workspace>/...
    region               = "us-east-1"
    encrypt              = true

    # Locking nativo de S3 (archivo .tflock), sin tabla DynamoDB extra.
    use_lockfile = true

    # Floci
    endpoints = {
      s3 = "http://localhost:4566"
    }
    access_key                  = "test"
    secret_key                  = "test"
    use_path_style              = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
  }
}
