variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "authenticated_config_id" {
  description = "Secret-bootstrap-created Hyperdrive ID for the RLS role."
  type        = string
}

variable "system_config_id" {
  description = "Secret-bootstrap-created Hyperdrive ID for the system role."
  type        = string
}
