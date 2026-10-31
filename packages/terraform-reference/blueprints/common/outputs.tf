output "cloudfront_domain_name" {
  value = aws_cloudfront_distribution.main.domain_name
}

output "distribution_id" {
  value = aws_cloudfront_distribution.main.id
}

output "frontend_bucket" {
  value = aws_s3_bucket.frontend.bucket
}

output "artifacts_bucket" {
  value = aws_s3_bucket.artifacts.bucket
}

output "codebuild_project" {
  value = aws_codebuild_project.build.name
}
{{#if F1}}

output "function_name" {
  value = aws_lambda_function.api.function_name
}
{{/if}}
{{#if F2}}

output "instance_id" {
  value = aws_instance.app.id
}

output "ecr_repository_url" {
  value = aws_ecr_repository.app.repository_url
}

# The instance's fixed outbound address (an outside database's allow-list).
output "public_ip" {
  value = aws_eip.app.public_ip
}
{{/if}}
