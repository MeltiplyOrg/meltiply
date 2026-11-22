resource "cloudflare_r2_bucket" "assets" {
  account_id    = var.account_id
  name          = var.bucket_name
  jurisdiction  = var.jurisdiction
  location      = var.location
  storage_class = "Standard"

  lifecycle {
    prevent_destroy = true
  }
}

resource "cloudflare_r2_bucket_cors" "assets" {
  account_id   = var.account_id
  bucket_name  = cloudflare_r2_bucket.assets.name
  jurisdiction = cloudflare_r2_bucket.assets.jurisdiction

  rules = [{
    id = "direct-browser-upload"
    allowed = {
      headers = [
        "content-type",
        "content-length",
        "x-amz-checksum-sha256",
        "x-amz-date",
        "x-amz-content-sha256",
        "x-amz-security-token",
      ]
      methods = ["GET", "PUT"]
      origins = sort(tolist(var.allowed_origins))
    }
    expose_headers  = ["etag", "x-amz-request-id"]
    max_age_seconds = 3600
  }]
}

resource "cloudflare_r2_bucket_lifecycle" "assets" {
  account_id   = var.account_id
  bucket_name  = cloudflare_r2_bucket.assets.name
  jurisdiction = cloudflare_r2_bucket.assets.jurisdiction

  rules = [
    {
      id      = "abort-incomplete-multipart"
      enabled = true
      conditions = {
        prefix = ""
      }
      abort_multipart_uploads_transition = {
        condition = {
          type    = "Age"
          max_age = var.multipart_abort_after_seconds
        }
      }
    },
    {
      id      = "expire-staging-objects"
      enabled = true
      conditions = {
        prefix = "staging/"
      }
      delete_objects_transition = {
        condition = {
          type    = "Age"
          max_age = var.staging_object_retention_seconds
        }
      }
    },
  ]
}
