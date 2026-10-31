data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "main" {
  cidr_block           = "10.42.0.0/16"
  enable_dns_support   = true
  enable_dns_hostnames = true

  tags = {
    Name = "autoinfra-${var.short_id}"
  }
}

resource "aws_internet_gateway" "main" {
  vpc_id = aws_vpc.main.id
}

# Public subnet: the instance reaches the internet through its own public IP,
# so no NAT Gateway (never Free-Tier-eligible).
resource "aws_subnet" "public" {
  vpc_id            = aws_vpc.main.id
  cidr_block        = "10.42.1.0/24"
  availability_zone = data.aws_availability_zones.available.names[0]
}

resource "aws_route_table" "public" {
  vpc_id = aws_vpc.main.id

  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.main.id
  }
}

resource "aws_route_table_association" "public" {
  subnet_id      = aws_subnet.public.id
  route_table_id = aws_route_table.public.id
}

# The plural data source only needs ec2:DescribeManagedPrefixLists; the
# singular one also reads every entry (ec2:GetManagedPrefixListEntries).
data "aws_ec2_managed_prefix_lists" "cloudfront" {
  filter {
    name   = "prefix-list-name"
    values = ["com.amazonaws.global.cloudfront.origin-facing"]
  }
}

# Dedicated group: the CloudFront prefix list consumes many rule slots.
resource "aws_security_group" "app" {
  name        = "autoinfra-${var.short_id}-app"
  description = "CloudFront origin-facing traffic only; no SSH (SSM is used instead)"
  vpc_id      = aws_vpc.main.id
}

resource "aws_vpc_security_group_ingress_rule" "cloudfront_http" {
  security_group_id = aws_security_group.app.id
  prefix_list_id    = tolist(data.aws_ec2_managed_prefix_lists.cloudfront.ids)[0]
  from_port         = 80
  to_port           = 80
  ip_protocol       = "tcp"
}

# Without a NAT Gateway or VPC interface endpoints (neither is Free-Tier-
# eligible) the instance reaches ECR, SSM, and package mirrors directly. The
# app itself may need any port out: a database hosted outside AWS (Supabase's
# 6543 pooler, Redis Cloud and Aiven use custom ports), SMTP for email
# (587/465), other services. Inbound stays CloudFront-only; DNS and NTP to the
# VPC resolver are not filtered by security groups.
resource "aws_vpc_security_group_egress_rule" "all" {
  security_group_id = aws_security_group.app.id
  cidr_ipv4         = "0.0.0.0/0"
  ip_protocol       = "-1"
}
