variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "app_hostname" {
  description = "Public dashboard/API custom hostname."
  type        = string
}

variable "frontend_worker_name" {
  description = "Frontend Worker owning the app hostname and forwarding /api/* internally."
  type        = string
}

variable "api_worker_name" {
  description = "API Worker service name."
  type        = string
}

variable "attach_custom_domains" {
  description = "Whether custom domains may be attached to the frontend and operator API Workers."
  type        = bool
}

variable "manage_zone_security" {
  description = "Whether this state is the sole owner of zone-level security entrypoints."
  type        = bool
}

variable "protected_app_hostnames" {
  description = "Environment-to-app-hostname coverage declared by the zone owner."
  type        = map(string)
}

variable "managed_waf_ruleset_id" {
  description = "Optional Cloudflare managed WAF ruleset ID enabled for the zone."
  type        = string
  default     = null
  nullable    = true
}

variable "operator_hostname" {
  description = "Optional Access-protected operator custom hostname."
  type        = string
  default     = null
  nullable    = true
}

variable "requests_per_minute" {
  description = "Per-IP API request threshold."
  type        = number
  default     = 120
}

variable "zone_id" {
  description = "Cloudflare zone identifier."
  type        = string
}
