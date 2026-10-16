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
      methods = ["PUT"]
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

  # Both rules are backstops for uploads that no database row will ever claim.
  # Ownership lives in PostgreSQL: the Asset's orphan clock drives reclamation of
  # completed objects, and this bucket never deletes an object on its own authority.
  #
  # Rule 1 aborts multipart uploads that were never completed. An incomplete
  # upload has no object and no row, so only the bucket can reclaim its parts.
  # It keeps an empty prefix so it also covers multipart sessions created outside
  # the staging namespace.
  #
  # Rule 2 expires completed objects that are still in the upload-writable
  # staging/ namespace. Promotion copies retained bytes into the ready
  # <org_id>/<asset_id>/ namespace before an attachment counts as ready, so a
  # staging object is always transient: either promoted and superseded by the
  # ready copy, or abandoned. Ready and rendition keys are never expired here.
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
