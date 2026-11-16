output "gateway_endpoint_ids" {
  value = {
    dynamodb = aws_vpc_endpoint.dynamodb.id
    s3       = aws_vpc_endpoint.s3.id
  }
}

output "interface_endpoint_ids" {
  value = { for k, v in aws_vpc_endpoint.interface : k => v.id }
}

output "execute_api_endpoint_id" {
  value = aws_vpc_endpoint.interface["execute-api"].id
}
