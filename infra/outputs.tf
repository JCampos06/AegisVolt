output "environment" {
  description = "Ambiente (workspace) actual."
  value       = local.env
}

output "state_key" {
  description = "Ruta del tfstate de este workspace dentro del bucket."
  value       = "env:/${local.env}/aegisvolt/terraform.tfstate"
}
