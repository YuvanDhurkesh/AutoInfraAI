data "aws_caller_identity" "current" {}

resource "aws_cloudwatch_log_group" "build" {
  name              = "/aws/codebuild/autoinfra-${var.short_id}-build"
  retention_in_days = 7
}

resource "aws_iam_role" "codebuild" {
  name = "autoinfra-${var.short_id}-codebuild"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "codebuild.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
}

resource "aws_iam_role_policy" "codebuild" {
  name = "autoinfra-${var.short_id}-codebuild"
  role = aws_iam_role.codebuild.id

  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["logs:CreateLogStream", "logs:PutLogEvents"]
        Resource = "${aws_cloudwatch_log_group.build.arn}:*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:GetObjectVersion"]
        Resource = "${aws_s3_bucket.artifacts.arn}/source/*"
      },
{{#unless F3}}
      {
        # Build outputs for the rollout (compose file, image tag, Lambda zip).
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:GetObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/deploy/*"
      },
{{/unless}}
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.frontend.arn
      },
      {
        Effect   = "Allow"
        Action   = ["s3:PutObject", "s3:DeleteObject"]
        Resource = "${aws_s3_bucket.frontend.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["cloudfront:CreateInvalidation"]
        Resource = aws_cloudfront_distribution.main.arn
      },
      {
        # Public build-time variables only (VITE_*, NEXT_PUBLIC_*, ...): they end
        # up in the browser bundle anyway. Names are listed, values read by name.
        Effect   = "Allow"
        Action   = ["ssm:DescribeParameters"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = ["ssm:GetParameters"]
        Resource = [
          for prefix in ["VITE_", "NEXT_PUBLIC_", "REACT_APP_", "VUE_APP_", "PUBLIC_"] :
          "arn:aws:ssm:${var.region}:${data.aws_caller_identity.current.account_id}:parameter/autoinfra/${var.short_id}/${prefix}*"
        ]
      },
{{#if F1}}
      {
        Effect   = "Allow"
        Action   = ["lambda:UpdateFunctionCode", "lambda:GetFunction", "lambda:GetFunctionConfiguration"]
        Resource = aws_lambda_function.api.arn
      },
{{/if}}
{{#if F2}}
      {
        Effect   = "Allow"
        Action   = ["ecr:GetAuthorizationToken"]
        Resource = "*"
      },
      {
        Effect = "Allow"
        Action = [
          "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
          "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:GetDownloadUrlForLayer",
        ]
        Resource = aws_ecr_repository.app.arn
      },
      {
        Effect = "Allow"
        Action = ["ssm:SendCommand"]
        Resource = [
          aws_instance.app.arn,
          "arn:aws:ssm:${var.region}::document/AWS-RunShellScript",
        ]
      },
      {
        Effect   = "Allow"
        Action   = ["ssm:GetCommandInvocation", "ssm:DescribeInstanceInformation"]
        Resource = "*"
      },
{{/if}}
    ]
  })
}

resource "aws_codebuild_project" "build" {
  name          = "autoinfra-${var.short_id}-build"
  service_role  = aws_iam_role.codebuild.arn
  build_timeout = {{BUILD_TIMEOUT}}

  source {
    type      = "S3"
    location  = "${aws_s3_bucket.artifacts.bucket}/source/latest.zip"
    buildspec = file("${path.module}/buildspec.yml")
  }

  artifacts {
    type = "NO_ARTIFACTS"
  }

  environment {
    compute_type    = "BUILD_GENERAL1_SMALL"
    image           = "aws/codebuild/amazonlinux-x86_64-standard:6.0"
    type            = "LINUX_CONTAINER"
    privileged_mode = {{PRIVILEGED}}

    environment_variable {
      name  = "FRONTEND_BUCKET"
      value = aws_s3_bucket.frontend.bucket
    }
    environment_variable {
      name  = "DISTRIBUTION_ID"
      value = aws_cloudfront_distribution.main.id
    }
    environment_variable {
      # The deployment's own public URL: the frontend calls its API here.
      name  = "SITE_URL"
      value = "https://${aws_cloudfront_distribution.main.domain_name}"
    }
    environment_variable {
      name  = "SSM_PREFIX"
      value = "/autoinfra/${var.short_id}"
    }
    environment_variable {
      name  = "API_PATH_PREFIX"
      value = var.api_path_prefix
    }
    environment_variable {
      name  = "ARTIFACTS_BUCKET"
      value = aws_s3_bucket.artifacts.bucket
    }
{{#if F1}}
    environment_variable {
      name  = "FUNCTION_NAME"
      value = aws_lambda_function.api.function_name
    }
{{/if}}
{{#if F2}}
    environment_variable {
      name  = "ECR_REPOSITORY_URL"
      value = aws_ecr_repository.app.repository_url
    }
    environment_variable {
      name  = "INSTANCE_ID"
      value = aws_instance.app.id
    }
{{/if}}
  }

  logs_config {
    cloudwatch_logs {
      group_name = aws_cloudwatch_log_group.build.name
    }
  }
}
