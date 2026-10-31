data "aws_cloudfront_cache_policy" "optimized" {
  name = "Managed-CachingOptimized"
}

data "aws_cloudfront_cache_policy" "disabled" {
  name = "Managed-CachingDisabled"
}
{{#if F1}}

# Forwards cookies, query strings and headers -- everything except Host,
# which must stay the Function URL's own host.
data "aws_cloudfront_origin_request_policy" "app" {
  name = "Managed-AllViewerExceptHostHeader"
}
{{/if}}
{{#if F2}}

# Forwards everything incl. cookies and WebSocket upgrade headers.
data "aws_cloudfront_origin_request_policy" "app" {
  name = "Managed-AllViewer"
}
{{/if}}

resource "aws_cloudfront_origin_access_control" "s3" {
  name                              = "autoinfra-${var.short_id}-s3"
  origin_access_control_origin_type = "s3"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}
{{#if F1}}

# Only for AWS_IAM. Not used for NONE: OAC to a Function URL breaks browser
# POST/PUT, which would need a client-computed payload hash.
resource "aws_cloudfront_origin_access_control" "lambda" {
  count = var.function_url_auth_type == "AWS_IAM" ? 1 : 0

  name                              = "autoinfra-${var.short_id}-lambda"
  origin_access_control_origin_type = "lambda"
  signing_behavior                  = "always"
  signing_protocol                  = "sigv4"
}

locals {
  api_origin_domain = replace(replace(aws_lambda_function_url.api.function_url, "https://", ""), "/", "")
}
{{/if}}
{{#if DEFAULT_S3}}

# Page paths without a file extension: {{PAGE_REWRITE_NOTE}}
resource "aws_cloudfront_function" "pages" {
  name    = "autoinfra-${var.short_id}-pages"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var uri = request.uri;
      var last = uri.split("/").pop();
      if (last.indexOf(".") !== -1) return request;
{{#if PAGES_SPA}}
      request.uri = "/index.html";
{{/if}}
{{#if PAGES_HTML}}
      request.uri = uri === "/" ? "/index.html" : uri.endsWith("/") ? uri + "index.html" : uri + ".html";
{{/if}}
{{#if PAGES_DIR}}
      request.uri = uri.endsWith("/") ? uri + "index.html" : uri + "/index.html";
{{/if}}
      return request;
    }
  JS
}
{{/if}}
{{#if STRIP_AT_EDGE}}

# The app's own routes don't start with the API prefix: strip it before the
# request reaches the backend.
resource "aws_cloudfront_function" "api_prefix" {
  name    = "autoinfra-${var.short_id}-api-prefix"
  runtime = "cloudfront-js-2.0"
  publish = true
  code    = <<-JS
    function handler(event) {
      var request = event.request;
      var prefix = "${var.api_path_prefix}";
      if (request.uri === prefix) {
        request.uri = "/";
      } else if (request.uri.indexOf(prefix + "/") === 0) {
        request.uri = request.uri.substring(prefix.length);
      }
      return request;
    }
  JS
}
{{/if}}

resource "aws_cloudfront_distribution" "main" {
  enabled      = true
  comment      = "autoinfra-${var.short_id}"
  price_class  = "PriceClass_100"
  http_version = "http2and3"
{{#if DEFAULT_S3}}

  default_root_object = "index.html"
{{/if}}

  origin {
    origin_id                = "s3-frontend"
    domain_name              = aws_s3_bucket.frontend.bucket_regional_domain_name
    origin_access_control_id = aws_cloudfront_origin_access_control.s3.id
  }
{{#if F1}}

  origin {
    origin_id                = "app"
    domain_name              = local.api_origin_domain
    origin_access_control_id = var.function_url_auth_type == "AWS_IAM" ? aws_cloudfront_origin_access_control.lambda[0].id : null

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "https-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 30
    }
  }
{{/if}}
{{#if F2}}

  # CloudFront -> instance is plain HTTP (no certificate on the instance); the
  # origin secret header authenticates CloudFront to Caddy.
  origin {
    origin_id   = "app"
    domain_name = aws_eip.app.public_dns

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
      origin_read_timeout    = 60
    }

    custom_header {
      name  = "X-AutoInfra-Origin-Secret"
      value = random_password.origin_secret.result
    }
  }
{{/if}}

{{#if DEFAULT_S3}}
  default_cache_behavior {
    target_origin_id       = "s3-frontend"
    viewer_protocol_policy = "redirect-to-https"
    allowed_methods        = ["GET", "HEAD", "OPTIONS"]
    cached_methods         = ["GET", "HEAD"]
    cache_policy_id        = data.aws_cloudfront_cache_policy.optimized.id
    compress               = true

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.pages.arn
    }
  }
{{else}}
  # Every page comes from the app itself (server-rendered frontend or API only).
  default_cache_behavior {
    target_origin_id         = "app"
    viewer_protocol_policy   = "redirect-to-https"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.app.id
    compress                 = true
  }
{{/if}}
{{#if HAS_BACKEND}}

  # Same-origin API: the frontend calls the relative path var.api_path_prefix,
  # so there is no CORS and no hardcoded backend URL.
  ordered_cache_behavior {
    path_pattern             = "${var.api_path_prefix}/*"
    target_origin_id         = "app"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.app.id
    compress                 = true
{{#if STRIP_AT_EDGE}}

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.api_prefix.arn
    }
{{/if}}
  }

  ordered_cache_behavior {
    path_pattern             = var.api_path_prefix
    target_origin_id         = "app"
    viewer_protocol_policy   = "https-only"
    allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
    cached_methods           = ["GET", "HEAD"]
    cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
    origin_request_policy_id = data.aws_cloudfront_origin_request_policy.app.id
{{#if STRIP_AT_EDGE}}

    function_association {
      event_type   = "viewer-request"
      function_arn = aws_cloudfront_function.api_prefix.arn
    }
{{/if}}
  }
{{/if}}
{{#if EDGE_BACKEND_PATHS}}

  # The backend's paths outside the API prefix ({{BACKEND_PATHS_NOTE}}):
  # socket.io, WebSockets, files it serves, OAuth routes. Passed unchanged.
  dynamic "ordered_cache_behavior" {
    for_each = flatten([for p in {{BACKEND_PATHS_HCL}} : [p, "${p}/*"]])
    content {
      path_pattern             = ordered_cache_behavior.value
      target_origin_id         = "app"
      viewer_protocol_policy   = "https-only"
      allowed_methods          = ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"]
      cached_methods           = ["GET", "HEAD"]
      cache_policy_id          = data.aws_cloudfront_cache_policy.disabled.id
      origin_request_policy_id = data.aws_cloudfront_origin_request_policy.app.id
      compress                 = true
    }
  }
{{/if}}

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }
}
