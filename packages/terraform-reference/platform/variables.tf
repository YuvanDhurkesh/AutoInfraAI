# Platform-managed: values come from autoinfra.auto.tfvars.json, written by
# AutoInfra from the deployment, the scan, and the verified AWS connection.

variable "region" {
  type = string
}

variable "deployment_id" {
  type = string
}

variable "owner" {
  type = string
}

variable "short_id" {
  description = "Short deployment id used in every resource name: autoinfra-<short_id>-*"
  type        = string
}

variable "api_path_prefix" {
  description = "Path prefix CloudFront routes to the backend, e.g. /api"
  type        = string
}

variable "app_port" {
  description = "Port the backend listens on inside Lambda (via the Web Adapter) or on EC2"
  type        = number
}

variable "health_check_path" {
  type = string
}

variable "function_url_auth_type" {
  description = "F1 only. AWS_IAM + CloudFront OAC for read-only APIs; NONE when the API has write routes (OAC breaks browser POST/PUT)."
  type        = string

  validation {
    condition     = contains(["AWS_IAM", "NONE"], var.function_url_auth_type)
    error_message = "function_url_auth_type must be AWS_IAM or NONE."
  }
}

variable "lambda_adapter_layer_arn" {
  description = "F1 only. AWS Lambda Web Adapter layer for the region."
  type        = string
}

variable "instance_type" {
  description = "F2 only. Chosen from the account's Free-Tier-eligible instance types."
  type        = string
}

variable "instance_architecture" {
  description = "F2 only. x86_64 or arm64, matching instance_type."
  type        = string
}
