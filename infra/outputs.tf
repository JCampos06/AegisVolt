output "environment" {
  description = "Ambiente (workspace) actual."
  value       = local.env
}

output "state_key" {
  description = "Ruta del tfstate de este workspace dentro del bucket."
  value       = "env:/${local.env}/aegisvolt/terraform.tfstate"
}

output "vpc_id" {
  value = module.network.vpc_id
}

output "private_subnet_ids" {
  value = module.network.private_subnet_ids
}

output "vpc_endpoints" {
  description = "IDs de los VPC Endpoints (Gateway e Interface)."
  value = merge(
    module.vpc_endpoints.gateway_endpoint_ids,
    module.vpc_endpoints.interface_endpoint_ids,
  )
}

output "dynamodb_tables" {
  value = module.dynamodb.table_names
}

output "log_groups" {
  value = module.cloudwatch.log_group_names
}

output "api_invoke_url" {
  value = module.api_gateway.invoke_url
}

output "ingress_target_group_arn" {
  value = module.api_gateway.target_group_arn
}
