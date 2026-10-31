# Platform-managed: AutoInfra writes this file on every run; generated
# bundles may not override it.
terraform {
  required_version = ">= 1.10.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 6.69"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.9"
    }
  }

  # bucket/key/region/use_lockfile are supplied at `terraform init` time
  # (Sec. 3.3: S3 state with native locking, no DynamoDB lock table).
  backend "s3" {}
}

provider "aws" {
  region = var.region

  default_tags {
    tags = {
      "autoinfra:deployment-id" = var.deployment_id
      "autoinfra:owner"         = var.owner
      "autoinfra:managed-by"    = "autoinfra"
      "autoinfra:free-tier"     = "true"
    }
  }
}
