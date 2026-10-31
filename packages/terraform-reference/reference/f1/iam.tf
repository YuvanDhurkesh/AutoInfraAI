data "aws_caller_identity" "current" {}

resource "aws_iam_role" "lambda" {
  name = "autoinfra-${var.short_id}-lambda"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "lambda.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy_attachment" "lambda_logs" {
  role       = aws_iam_role.lambda.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

resource "aws_iam_role_policy" "lambda_app" {
  name = "autoinfra-${var.short_id}-lambda-app"
  role = aws_iam_role.lambda.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        # Env vars and secrets live in SSM Parameter Store (SecureString,
        # AWS-managed key), written by AutoInfra -- never in Terraform.
        Effect   = "Allow"
        Action   = ["ssm:GetParametersByPath", "ssm:GetParameter", "ssm:GetParameters"]
        Resource = [
          "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/autoinfra/${var.short_id}",
          "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/autoinfra/${var.short_id}/*",
        ]
      },
      {
        Effect = "Allow"
        Action = [
          "dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem",
          "dynamodb:Query", "dynamodb:Scan", "dynamodb:BatchGetItem", "dynamodb:BatchWriteItem",
        ]
        Resource = [aws_dynamodb_table.data.arn, "${aws_dynamodb_table.data.arn}/index/*"]
      },
    ]
  })
}
