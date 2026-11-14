provider "aws" {
  region                      = var.region
  access_key                  = "test"
  secret_key                  = "test"
  skip_credentials_validation = true
  skip_metadata_api_check     = true
  skip_requesting_account_id  = true
  s3_use_path_style           = true

  # Floci exige declarar el endpoint de CADA servicio que usa la configuración.
  endpoints {
    apigateway   = var.aws_endpoint
    apigatewayv2 = var.aws_endpoint
    cloudwatch   = var.aws_endpoint
    dynamodb     = var.aws_endpoint
    ec2          = var.aws_endpoint
    elbv2        = var.aws_endpoint
    iam          = var.aws_endpoint
    logs         = var.aws_endpoint
    s3           = var.aws_endpoint
    sts          = var.aws_endpoint
  }

  default_tags {
    tags = local.common_tags
  }
}
