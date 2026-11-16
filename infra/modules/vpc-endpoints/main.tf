# -----------------------------------------------------------------------------
# Módulo vpc-endpoints: acceso privado a servicios AWS sin salir a internet.
#
#  Gateway VPCE  (S3, DynamoDB): se asocian a la route table privada; AWS agrega
#                 una ruta con la prefix list del servicio -> el tráfico va por
#                 la red de AWS, no por IGW/NAT.
#  Interface VPCE (logs, monitoring, execute-api, sts): ENIs en subredes privadas
#                 con DNS privado -> el FQDN público del servicio resuelve a IPs
#                 privadas de la VPC.
# -----------------------------------------------------------------------------

data "aws_region" "current" {}

locals {
  svc = "com.amazonaws.${data.aws_region.current.region}"

  interface_services = {
    logs        = "CloudWatch Logs (logs de los microservicios)"
    monitoring  = "CloudWatch Metrics (análisis del canary)"
    execute-api = "API Gateway (invocaciones privadas desde la VPC)"
    sts         = "STS (credenciales temporales IRSA de los pods)"
  }
}

# --- Gateway endpoints -------------------------------------------------------

resource "aws_vpc_endpoint" "dynamodb" {
  vpc_id            = var.vpc_id
  service_name      = "${local.svc}.dynamodb"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = var.private_route_table_ids

  # Política del endpoint: desde esta VPC solo se pueden tocar las tablas
  # del MISMO ambiente. Un pod de dev no puede escribir en aegisvolt-*-prod.
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Sid       = "OnlySameEnvironmentTables"
      Effect    = "Allow"
      Principal = "*"
      Action    = "dynamodb:*"
      Resource = [
        "arn:aws:dynamodb:*:*:table/${var.name_prefix}-*-${var.env}",
        "arn:aws:dynamodb:*:*:table/${var.name_prefix}-*-${var.env}/index/*",
      ]
    }]
  })

  tags = { Name = "${var.name_prefix}-vpce-dynamodb-${var.env}" }
}

resource "aws_vpc_endpoint" "s3" {
  vpc_id            = var.vpc_id
  service_name      = "${local.svc}.s3"
  vpc_endpoint_type = "Gateway"
  route_table_ids   = var.private_route_table_ids

  tags = { Name = "${var.name_prefix}-vpce-s3-${var.env}" }
}

# --- Interface endpoints -----------------------------------------------------

resource "aws_vpc_endpoint" "interface" {
  for_each = local.interface_services

  vpc_id              = var.vpc_id
  service_name        = "${local.svc}.${each.key}"
  vpc_endpoint_type   = "Interface"
  subnet_ids          = var.private_subnet_ids
  security_group_ids  = [var.sg_vpc_endpoints_id]
  private_dns_enabled = true

  tags = {
    Name    = "${var.name_prefix}-vpce-${each.key}-${var.env}"
    Purpose = each.value
  }
}
