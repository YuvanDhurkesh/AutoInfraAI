data "aws_ssm_parameter" "al2023_ami" {
  name = "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-${var.instance_architecture}"
}

# Shared secret CloudFront sends as a custom origin header; Caddy on the
# instance rejects requests without it. Platform-generated (not a user
# secret), stored in SSM so the instance can read it at deploy time.
resource "random_password" "origin_secret" {
  length  = 40
  special = false
}

resource "aws_ssm_parameter" "origin_secret" {
  name  = "/autoinfra/${var.short_id}/platform/ORIGIN_SECRET"
  type  = "SecureString"
  value = random_password.origin_secret.result
}

# Password for the database container (example app uses Postgres). Same
# pattern: platform-generated, read from SSM into .env by deploy.sh.
resource "random_password" "db_password" {
  length  = 32
  special = false
}

resource "aws_ssm_parameter" "db_password" {
  name  = "/autoinfra/${var.short_id}/platform/AUTOINFRA_DB_PASSWORD"
  type  = "SecureString"
  value = random_password.db_password.result
}

resource "aws_ecr_repository" "app" {
  name                 = "autoinfra-${var.short_id}-app"
  image_tag_mutability = "IMMUTABLE" # every build pushes a unique build-number tag
  force_delete         = true

  encryption_configuration {
    encryption_type = "AES256"
  }

  image_scanning_configuration {
    scan_on_push = true # basic scanning is free
  }
}

resource "aws_ecr_lifecycle_policy" "app" {
  repository = aws_ecr_repository.app.name

  policy = jsonencode({
    rules = [{
      rulePriority = 1
      description  = "Keep the last 2 images (current + rollback)"
      selection = {
        tagStatus   = "any"
        countType   = "imageCountMoreThan"
        countNumber = 2
      }
      action = { type = "expire" }
    }]
  })
}

resource "aws_instance" "app" {
  ami                         = data.aws_ssm_parameter.al2023_ami.value
  instance_type               = var.instance_type
  subnet_id                   = aws_subnet.public.id
  vpc_security_group_ids      = [aws_security_group.app.id]
  iam_instance_profile        = aws_iam_instance_profile.app.name
  associate_public_ip_address = true # replaced by the EIP below; still one public IPv4

  root_block_device {
    volume_type = "gp3"
    volume_size = 20 # total EBS must stay <= 30 GB
    encrypted   = true
  }

  metadata_options {
    http_endpoint = "enabled"
    http_tokens   = "required"
  }

  user_data = templatefile("${path.module}/app/bootstrap.sh", {
    region           = var.region
    short_id         = var.short_id
    artifacts_bucket = aws_s3_bucket.artifacts.bucket
    ecr_registry     = split("/", aws_ecr_repository.app.repository_url)[0]
  })

  tags = {
    Name = "autoinfra-${var.short_id}-app"
  }

  lifecycle {
    # A newer AMI must not silently replace the instance (and its data).
    ignore_changes = [ami, user_data]
  }
}

# Stable origin hostname across stop/start (pause/resume). Always attached,
# so it is never an unattached, billable EIP.
resource "aws_eip" "app" {
  domain   = "vpc"
  instance = aws_instance.app.id
}
