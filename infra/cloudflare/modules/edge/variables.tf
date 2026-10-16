variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "api_hostname" {
  description = "Public API custom hostname."
  type        = string
}

variable "api_worker_name" {
  description = "API Worker service name."
  type        = string
}

variable "attach_custom_domains" {
  description = "Whether custom domains may be attached to the deployed API Worker."
  type        = bool
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
