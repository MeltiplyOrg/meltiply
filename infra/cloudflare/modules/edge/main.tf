resource "cloudflare_workers_custom_domain" "api" {
  count = var.attach_custom_domains ? 1 : 0

  account_id = var.account_id
  hostname   = var.app_hostname
  service    = var.frontend_worker_name
  zone_id    = var.zone_id
}

resource "cloudflare_workers_custom_domain" "operator" {
  count = var.attach_custom_domains && var.operator_hostname != null ? 1 : 0

  account_id = var.account_id
  hostname   = var.operator_hostname
  service    = var.api_worker_name
  zone_id    = var.zone_id
}

resource "cloudflare_ruleset" "rate_limit" {
  zone_id     = var.zone_id
  name        = "Meltiply API rate controls"
  description = "Bound per-IP limit for the staging API surface."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    action      = "block"
    description = "Block sustained API request bursts."
    enabled     = true
    expression  = "(http.host eq \"${var.app_hostname}\" and starts_with(http.request.uri.path, \"/api/\"))"
    ref         = "meltiply-api-per-ip"
    ratelimit = {
      characteristics     = ["cf.colo.id", "ip.src"]
      mitigation_timeout  = 60
      period              = 60
      requests_per_period = var.requests_per_minute
      requests_to_origin  = true
    }
  }]
}

resource "cloudflare_ruleset" "managed_waf" {
  count = var.managed_waf_ruleset_id == null ? 0 : 1

  zone_id     = var.zone_id
  name        = "Meltiply managed WAF"
  description = "Cloudflare managed protections for the staging API."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [{
    action      = "execute"
    description = "Execute the approved Cloudflare managed ruleset."
    enabled     = true
    expression  = "http.host eq \"${var.app_hostname}\""
    ref         = "meltiply-managed-waf"
    action_parameters = {
      id = var.managed_waf_ruleset_id
    }
  }]
}
