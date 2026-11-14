# -----------------------------------------------------------------------------
# Módulo cloudwatch: log groups por ambiente y servicio + métricas de error.
#
#   /aegisvolt/<env>/<service>   (logs JSON con correlation_id)
#
# Los metric filters convierten logs en métricas (namespace AegisVolt/<env>):
#   - ServiceErrors   : logs con level = "error"
#   - Http5xx         : respuestas HTTP 5xx (usada por el AnalysisTemplate del canary)
#   - SagaCompensated : sagas que terminaron en COMPENSATED
# -----------------------------------------------------------------------------

locals {
  namespace = "AegisVolt/${var.env}"
}

resource "aws_cloudwatch_log_group" "service" {
  for_each = toset(var.services)

  name              = "/${var.name_prefix}/${var.env}/${each.key}"
  retention_in_days = var.retention_days

  tags = { Service = each.key }
}

resource "aws_cloudwatch_log_metric_filter" "errors" {
  for_each = aws_cloudwatch_log_group.service

  name           = "${each.key}-errors"
  log_group_name = each.value.name
  pattern        = "{ $.level = \"error\" }"

  metric_transformation {
    name      = "ServiceErrors"
    namespace = local.namespace
    value     = "1"
    # AWS no permite default_value cuando hay dimensions
    dimensions = {
      Service = "$.service"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "http_5xx" {
  for_each = aws_cloudwatch_log_group.service

  name           = "${each.key}-http5xx"
  log_group_name = each.value.name
  pattern        = "{ $.statusCode >= 500 }"

  metric_transformation {
    name      = "Http5xx"
    namespace = local.namespace
    value     = "1"
    # AWS no permite default_value cuando hay dimensions
    dimensions = {
      Service = "$.service"
      Version = "$.version"
    }
  }
}

resource "aws_cloudwatch_log_metric_filter" "saga_compensated" {
  name           = "saga-compensated"
  log_group_name = aws_cloudwatch_log_group.service["graphql-gateway"].name
  pattern        = "{ $.saga_status = \"COMPENSATED\" }"

  metric_transformation {
    name          = "SagaCompensated"
    namespace     = local.namespace
    value         = "1"
    default_value = "0"
  }
}
