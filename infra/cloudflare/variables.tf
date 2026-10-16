variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone identifier for meltiply.com."
  type        = string
}

variable "environment" {
  description = "Staging deployment environment owned by this stack."
  type        = string
  default     = "staging"

  validation {
    condition     = var.environment == "staging"
    error_message = "This Cloudflare stack is staging-only; preview requires isolated resource identifiers and a separate stack."
  }
}

variable "api_hostname" {
  description = "Public API custom hostname."
  type        = string
  default     = "api.staging.meltiply.com"
}

variable "api_worker_name" {
  description = "API Worker service name owned by Wrangler deployment."
  type        = string
  default     = "meltiply-api"
}

variable "automation_worker_name" {
  description = "Automation Worker service name owned by Wrangler deployment."
  type        = string
  default     = "meltiply-automation"
}

variable "attach_api_custom_domains" {
  description = "Attach API/operator custom domains only after the API Worker exists."
  type        = bool
  default     = false
}

variable "attach_queue_consumers" {
  description = "Attach workload consumers only after the Automation Worker exists."
  type        = bool
  default     = false
}

variable "queue_delivery_paused" {
  description = "Keep workload Queue delivery paused during bootstrap and rollout."
  type        = bool
  default     = true
}

variable "assets_bucket_name" {
  description = "Private asset bucket name."
  type        = string
  default     = "meltiply-assets-staging"
}

variable "frontend_origins" {
  description = "Exact HTTPS browser origins accepted by API and R2 CORS."
  type        = set(string)
}

variable "authenticated_hyperdrive_config_id" {
  description = "ID created by protected Hyperdrive secret bootstrap for the RLS role."
  type        = string
}

variable "system_hyperdrive_config_id" {
  description = "ID created by protected Hyperdrive secret bootstrap for the system role."
  type        = string
}

variable "managed_waf_ruleset_id" {
  description = "Approved Cloudflare managed WAF ruleset ID, when available for the plan."
  type        = string
  default     = null
  nullable    = true
}

variable "rate_limit_requests_per_minute" {
  description = "Per-IP API request threshold."
  type        = number
  default     = 120

  validation {
    condition = (
      var.rate_limit_requests_per_minute >= 1 &&
      floor(var.rate_limit_requests_per_minute) == var.rate_limit_requests_per_minute
    )
    error_message = "The per-IP request threshold must be a positive integer."
  }
}

variable "enable_operator_access" {
  description = "Whether to provision an Access-protected operator surface."
  type        = bool
  default     = false

  validation {
    condition = (
      !var.enable_operator_access ||
      (
        length(var.operator_email_domains) > 0 &&
        var.access_team_domain != null &&
        can(regex("^https://[a-z0-9.-]+\\.cloudflareaccess\\.com$", var.access_team_domain))
      )
    )
    error_message = "Operator Access requires an allowed email domain and HTTPS Cloudflare Access team domain."
  }
}

variable "operator_hostname" {
  description = "Operator-only hostname protected by Cloudflare Access."
  type        = string
  default     = "ops.staging.meltiply.com"
}

variable "access_team_domain" {
  description = "Cloudflare Access team domain used as the operator JWT issuer."
  type        = string
  default     = null
  nullable    = true
}

variable "operator_email_domains" {
  description = "Email domains allowed into the operator surface."
  type        = set(string)
  default     = []
}

variable "common_tags" {
  description = "Standard tags applied to tag-capable resources (AUD-045)."
  type        = set(string)
  default     = []
}
