output "vpc_id" {
  value = aws_vpc.this.id
}

output "vpc_cidr" {
  value = aws_vpc.this.cidr_block
}

output "public_subnet_ids" {
  value = aws_subnet.public[*].id
}

output "private_subnet_ids" {
  value = aws_subnet.private[*].id
}

output "private_route_table_id" {
  value = aws_route_table.private.id
}

output "public_route_table_id" {
  value = aws_route_table.public.id
}

output "sg_vpc_link_id" {
  value = aws_security_group.vpc_link.id
}

output "sg_k8s_nodes_id" {
  value = aws_security_group.k8s_nodes.id
}

output "sg_vpc_endpoints_id" {
  value = aws_security_group.vpc_endpoints.id
}
