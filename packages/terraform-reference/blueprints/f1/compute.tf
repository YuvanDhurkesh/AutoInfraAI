resource "aws_cloudwatch_log_group" "api" {
  name              = "/aws/lambda/autoinfra-${var.short_id}-api"
  retention_in_days = 7
}

# The app runs unchanged behind the AWS Lambda Web Adapter. AutoInfra ships
# a placeholder zip that serves 503 until the first build; CodeBuild then
# deploys the real code, so code changes are ignored here.
resource "aws_lambda_function" "api" {
  function_name    = "autoinfra-${var.short_id}-api"
  role             = aws_iam_role.lambda.arn
  runtime          = "{{LAMBDA_RUNTIME}}"
  handler          = "run.sh"
  architectures    = ["x86_64"]
  memory_size      = 512
  timeout          = 29 # CloudFront's origin response timeout is 30s
  filename         = "${path.module}/bootstrap/placeholder.zip"
  source_code_hash = filebase64sha256("${path.module}/bootstrap/placeholder.zip")
  layers           = [var.lambda_adapter_layer_arn]

  environment {
    variables = {
      AWS_LAMBDA_EXEC_WRAPPER      = "/opt/bootstrap"
      AWS_LWA_PORT                 = tostring(var.app_port)
      AWS_LWA_READINESS_CHECK_PATH = var.health_check_path
      AUTOINFRA_SSM_PREFIX         = "/autoinfra/${var.short_id}/"
{{#if DYNAMODB}}
      TABLE_NAME                   = aws_dynamodb_table.data.name
{{/if}}
    }
  }

  lifecycle {
    ignore_changes = [filename, source_code_hash]
  }

  depends_on = [aws_cloudwatch_log_group.api]
}

resource "aws_lambda_function_url" "api" {
  function_name      = aws_lambda_function.api.function_name
  authorization_type = var.function_url_auth_type
}

# Since October 2025, new Function URLs need BOTH lambda:InvokeFunctionUrl
# and lambda:InvokeFunction (the latter with invoked_via_function_url).
resource "aws_lambda_permission" "url_invoke_url" {
  statement_id           = "FunctionUrlInvokeUrl"
  action                 = "lambda:InvokeFunctionUrl"
  function_name          = aws_lambda_function.api.function_name
  function_url_auth_type = var.function_url_auth_type
  principal              = var.function_url_auth_type == "AWS_IAM" ? "cloudfront.amazonaws.com" : "*"
  source_arn             = var.function_url_auth_type == "AWS_IAM" ? aws_cloudfront_distribution.main.arn : null
}

resource "aws_lambda_permission" "url_invoke_function" {
  statement_id             = "FunctionUrlInvokeFunction"
  action                   = "lambda:InvokeFunction"
  function_name            = aws_lambda_function.api.function_name
  invoked_via_function_url = true
  principal                = var.function_url_auth_type == "AWS_IAM" ? "cloudfront.amazonaws.com" : "*"
  source_arn               = var.function_url_auth_type == "AWS_IAM" ? aws_cloudfront_distribution.main.arn : null
}
{{#if DYNAMODB}}

resource "aws_dynamodb_table" "data" {
  name         = "autoinfra-${var.short_id}-data"
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }
}
{{/if}}
