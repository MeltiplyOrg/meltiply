variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "bucket_name" {
  description = "Private R2 bucket name."
  type        = string
}

variable "allowed_origins" {
  description = "Exact browser origins allowed to upload directly to R2."
  type        = set(string)

  validation {
    condition = length(var.allowed_origins) > 0 && alltrue([
      for origin in var.allowed_origins :
      startswith(origin, "https://") && origin != "https://*"
    ])
    error_message = "R2 CORS origins must be explicit HTTPS origins."
  }
}

variable "jurisdiction" {
  description = "R2 data jurisdiction."
  type        = string
  default     = "default"
}

variable "location" {
  description = "Best-effort R2 bucket location."
  type        = string
  default     = "enam"
}

variable "multipart_abort_after_seconds" {
  description = "Age after which incomplete multipart uploads are aborted."
  type        = number
  default     = 86400
}

variable "staging_object_retention_seconds" {
  description = <<-EOT
    Backstop age for completed objects left in the upload-writable staging/
    namespace. Must stay at or above the seven-day orphan deadline the Asset
    sweep applies, so a session that still owns a staging object is never
    expired by the bucket before the database releases it.
  EOT
  type        = number
  default     = 604800
}
