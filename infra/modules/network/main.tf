# -----------------------------------------------------------------------------
# Módulo network: VPC dedicada por ambiente con subredes públicas y privadas.
#
#   Públicas  -> ruta 0.0.0.0/0 al Internet Gateway (solo balanceadores públicos)
#   Privadas  -> SIN ruta a internet. Pods, NLB interno y ENIs del VPC Link viven
#                aquí; el acceso a AWS (S3, DynamoDB, Logs) es por VPC Endpoints.
# -----------------------------------------------------------------------------

locals {
  azs = slice(var.availability_zones, 0, var.az_count)
}

resource "aws_vpc" "this" {
  cidr_block           = var.vpc_cidr
  enable_dns_support   = true
  enable_dns_hostnames = true # requerido por Interface VPCE con private DNS

  tags = { Name = "${var.name_prefix}-vpc-${var.env}" }
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-igw-${var.env}" }
}

# /16 -> subredes /20. Públicas: índices 0..n-1. Privadas: índices 8..8+n-1.
resource "aws_subnet" "public" {
  count                   = var.az_count
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet(var.vpc_cidr, 4, count.index)
  availability_zone       = local.azs[count.index]
  map_public_ip_on_launch = true

  tags = {
    Name                     = "${var.name_prefix}-public-${local.azs[count.index]}-${var.env}"
    Tier                     = "public"
    "kubernetes.io/role/elb" = "1"
  }
}

resource "aws_subnet" "private" {
  count             = var.az_count
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet(var.vpc_cidr, 4, count.index + 8)
  availability_zone = local.azs[count.index]

  tags = {
    Name                              = "${var.name_prefix}-private-${local.azs[count.index]}-${var.env}"
    Tier                              = "private"
    "kubernetes.io/role/internal-elb" = "1"
  }
}

# --- Tablas de rutas ---------------------------------------------------------

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-rt-public-${var.env}" }
}

resource "aws_route" "public_internet" {
  route_table_id         = aws_route_table.public.id
  destination_cidr_block = "0.0.0.0/0"
  gateway_id             = aws_internet_gateway.this.id
}

resource "aws_route_table_association" "public" {
  count          = var.az_count
  subnet_id      = aws_subnet.public[count.index].id
  route_table_id = aws_route_table.public.id
}

# Tabla privada: solo ruta "local" (implícita) + prefix lists de los Gateway VPCE
# (S3/DynamoDB) que agrega el módulo vpc-endpoints. Sin 0.0.0.0/0.
resource "aws_route_table" "private" {
  vpc_id = aws_vpc.this.id
  tags   = { Name = "${var.name_prefix}-rt-private-${var.env}" }
}

resource "aws_route_table_association" "private" {
  count          = var.az_count
  subnet_id      = aws_subnet.private[count.index].id
  route_table_id = aws_route_table.private.id
}

# --- Security Groups ---------------------------------------------------------

# ENIs del VPC Link de API Gateway: solo salen hacia el NLB interno.
resource "aws_security_group" "vpc_link" {
  name        = "${var.name_prefix}-sg-vpclink-${var.env}"
  description = "ENIs del VPC Link de API Gateway hacia el NLB interno"
  vpc_id      = aws_vpc.this.id

  egress {
    description = "HTTP hacia el NLB/Ingress en subredes privadas"
    from_port   = 80
    to_port     = 80
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${var.name_prefix}-sg-vpclink-${var.env}" }
}

# Nodos/pods de Kubernetes (Ingress NGINX): solo aceptan tráfico desde el VPC Link.
resource "aws_security_group" "k8s_nodes" {
  name        = "${var.name_prefix}-sg-k8s-nodes-${var.env}"
  description = "Nodos de Kubernetes: entrada solo desde el VPC Link y dentro de la VPC"
  vpc_id      = aws_vpc.this.id

  ingress {
    description     = "HTTP desde el VPC Link de API Gateway"
    from_port       = 80
    to_port         = 80
    protocol        = "tcp"
    security_groups = [aws_security_group.vpc_link.id]
  }

  ingress {
    description = "Trafico interno entre nodos/pods" # AWS no admite tildes aquí
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    self        = true
  }

  egress {
    description = "Salida dentro de la VPC (VPC Endpoints)"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${var.name_prefix}-sg-k8s-nodes-${var.env}" }
}

# Interface VPC Endpoints: HTTPS solo desde dentro de la VPC.
resource "aws_security_group" "vpc_endpoints" {
  name        = "${var.name_prefix}-sg-vpce-${var.env}"
  description = "Interface VPC Endpoints: HTTPS solo desde la VPC"
  vpc_id      = aws_vpc.this.id

  ingress {
    description = "HTTPS desde la VPC"
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = [var.vpc_cidr]
  }

  tags = { Name = "${var.name_prefix}-sg-vpce-${var.env}" }
}
