variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "allowed_email_domains" {
  description = "Identity email domains allowed into protected operator surfaces."
  type        = set(string)
}

variable "application_domain" {
  description = "Operator-only hostname protected by Access."
  type        = string
}

variable "application_name" {
  description = "Access application display name."
  type        = string
}

variable "tags" {
  description = "Standard resource tags applied to tag-capable resources."
  type        = set(string)
  default     = []
}
