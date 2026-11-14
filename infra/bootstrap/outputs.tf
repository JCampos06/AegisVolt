output "state_bucket" {
  description = "Nombre del bucket de estados."
  value       = aws_s3_bucket.tfstate.bucket
}

output "versioning_status" {
  description = "Estado del versionamiento del bucket."
  value       = aws_s3_bucket_versioning.tfstate.versioning_configuration[0].status
}
