# -----------------------------------------------------------------------------
# Módulo api-gateway: punto de entrada público hacia el clúster privado.
#
#  Cliente --HTTPS--> API Gateway HTTP API (stage = <env>)
#          --VPC Link (ENIs en subredes privadas, SG vpc_link)-->
#          NLB interno (subredes privadas) :80
#          --> Target Group (IPs del NGINX Ingress Controller en Kubernetes)
#          --> Service ClusterIP --> Pod graphql-gateway
#
# El NLB es interno (sin IP pública): solo es alcanzable a través del VPC Link.
# -----------------------------------------------------------------------------

resource "aws_lb" "internal" {
  name               = "${var.name_prefix}-nlb-${var.env}"
  internal           = true
  load_balancer_type = "network"
  subnets            = var.private_subnet_ids

  enable_deletion_protection = var.env == "prod"

  tags = { Name = "${var.name_prefix}-nlb-${var.env}" }
}

# Los targets (IPs de los pods del Ingress) los registra el AWS Load Balancer
# Controller / TargetGroupBinding desde Kubernetes, no Terraform.
resource "aws_lb_target_group" "ingress" {
  name        = "${var.name_prefix}-tg-ingress-${var.env}"
  port        = 80
  protocol    = "TCP"
  target_type = "ip"
  vpc_id      = var.vpc_id

  health_check {
    protocol            = "HTTP"
    path                = "/healthz"
    port                = "traffic-port"
    healthy_threshold   = 2
    unhealthy_threshold = 2
    interval            = 10
  }
}

resource "aws_lb_listener" "http" {
  load_balancer_arn = aws_lb.internal.arn
  port              = 80
  protocol          = "TCP"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.ingress.arn
  }
}

# --- API Gateway -------------------------------------------------------------

resource "aws_apigatewayv2_vpc_link" "this" {
  name               = "${var.name_prefix}-vpclink-${var.env}"
  subnet_ids         = var.private_subnet_ids
  security_group_ids = [var.sg_vpc_link_id]
}

resource "aws_apigatewayv2_api" "this" {
  name          = "${var.name_prefix}-api-${var.env}"
  protocol_type = "HTTP"
  description   = "AegisVolt GraphQL API (${var.env})"

  cors_configuration {
    allow_origins = var.cors_allow_origins
    allow_methods = ["GET", "POST", "OPTIONS"]
    allow_headers = ["content-type", "authorization", "x-correlation-id"]
    max_age       = 300
  }
}

resource "aws_apigatewayv2_integration" "graphql" {
  api_id             = aws_apigatewayv2_api.this.id
  integration_type   = "HTTP_PROXY"
  integration_method = "ANY"
  integration_uri    = aws_lb_listener.http.arn
  connection_type    = "VPC_LINK"
  connection_id      = aws_apigatewayv2_vpc_link.this.id

  # Propaga/genera el correlation_id hacia el clúster.
  request_parameters = {
    "overwrite:header.x-request-id" = "$context.requestId"
  }
}

resource "aws_apigatewayv2_route" "graphql" {
  for_each = toset(["POST /graphql", "GET /graphql", "GET /health"])

  api_id    = aws_apigatewayv2_api.this.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.graphql.id}"
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/${var.name_prefix}/${var.env}/apigateway"
  retention_in_days = var.log_retention_days
}

resource "aws_apigatewayv2_stage" "env" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = var.env
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = var.throttling_burst_limit
    throttling_rate_limit  = var.throttling_rate_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId      = "$context.requestId"
      ip             = "$context.identity.sourceIp"
      method         = "$context.httpMethod"
      path           = "$context.path"
      status         = "$context.status"
      latencyMs      = "$context.responseLatency"
      integrationErr = "$context.integrationErrorMessage"
      env            = var.env
    })
  }
}
