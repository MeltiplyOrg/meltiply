variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone identifier for meltiply.com."
  type        = string
}

variable "environment" {
  description = "Deployment environment; each installation requires isolated protected state and inputs."
  type        = string
  default     = "staging"

  validation {
    condition     = contains(jsondecode(file("${path.module}/../../scripts/lib/release-environments.json")), var.environment)
    error_message = "The Cloudflare environment must be in the shared release environment allow-list."
  }
}

variable "app_url" {
  description = "Canonical HTTPS dashboard/API origin; hostname and trusted origin are derived."
  type        = string
  default     = "https://staging.meltiply.com"

  validation {
    condition     = can(regex("^https://[a-z0-9][a-z0-9.-]*[a-z0-9]$", var.app_url))
    error_message = "app_url must be an HTTPS origin with no port, path, credentials, query, or fragment."
  }
}

variable "api_worker_name" {
  description = "API Worker service name owned by Wrangler deployment."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.api_worker_name == null || var.environment == "staging" ? true : endswith(var.api_worker_name, "-${var.environment}")
    error_message = "The production API Worker name must carry the selected environment suffix."
  }
}

variable "frontend_worker_name" {
  description = "Frontend Worker serving the app origin and proxying /api/* through its API binding."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.frontend_worker_name == null ? true : endswith(var.frontend_worker_name, "-${var.environment}")
    error_message = "The frontend Worker name must carry the selected environment suffix."
  }
}

variable "automation_worker_name" {
  description = "Automation Worker service name owned by Wrangler deployment."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.automation_worker_name == null || var.environment == "staging" ? true : endswith(var.automation_worker_name, "-${var.environment}")
    error_message = "The production Automation Worker name must carry the selected environment suffix."
  }
}

variable "state_worker_name" {
  description = "State Worker service name owned by Wrangler deployment."
  type        = string
  default     = null
  nullable    = true

  validation {
    condition     = var.state_worker_name == null || var.environment == "staging" ? true : endswith(var.state_worker_name, "-${var.environment}")
    error_message = "The production State Worker name must carry the selected environment suffix."
  }
}

variable "attach_app_custom_domains" {
  description = "Attach app/operator domains only after frontend and API Workers exist."
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
  default     = null
  nullable    = true

  validation {
    condition     = var.assets_bucket_name == null ? true : endswith(var.assets_bucket_name, "-${var.environment}")
    error_message = "The private asset bucket name must carry the selected environment suffix."
  }
}

variable "allowed_origins" {
  description = "Optional additional HTTPS browser origins accepted by API and R2 CORS; app_url is included automatically."
  type        = set(string)
  default     = []
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
