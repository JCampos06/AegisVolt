output "api_id" {
  value = aws_apigatewayv2_api.this.id
}

output "invoke_url" {
  description = "URL pública del stage del ambiente."
  value       = aws_apigatewayv2_stage.env.invoke_url
}

output "vpc_link_id" {
  value = aws_apigatewayv2_vpc_link.this.id
}

output "nlb_arn" {
  value = aws_lb.internal.arn
}

output "target_group_arn" {
  description = "Target group donde Kubernetes registra los pods del Ingress."
  value       = aws_lb_target_group.ingress.arn
}
