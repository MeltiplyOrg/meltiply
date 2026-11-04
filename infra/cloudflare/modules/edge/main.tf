locals {
  protected_hostnames = sort(distinct(values(var.protected_app_hostnames)))
  # Keep the single-host expression stable; a shared owner extends it to both apps.
  host_expression = length(local.protected_hostnames) == 1 ? "http.host eq ${jsonencode(local.protected_hostnames[0])}" : "http.host in {${join(" ", [for hostname in local.protected_hostnames : jsonencode(hostname)])}}"
}

# Adding ownership must not replace the existing staging entrypoint.
moved {
  from = cloudflare_ruleset.rate_limit
  to   = cloudflare_ruleset.rate_limit[0]
}

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
  count = var.manage_zone_security ? 1 : 0

  zone_id     = var.zone_id
  name        = "Meltiply API rate controls"
  description = "Bound per-IP limit for the protected API surfaces."
  kind        = "zone"
  phase       = "http_ratelimit"

  rules = [{
    action      = "block"
    description = "Block sustained API request bursts."
    enabled     = true
    expression  = "(${local.host_expression} and starts_with(http.request.uri.path, \"/api/\"))"
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
  count = var.manage_zone_security && var.managed_waf_ruleset_id != null ? 1 : 0

  zone_id     = var.zone_id
  name        = "Meltiply managed WAF"
  description = "Cloudflare managed protections for the protected apps."
  kind        = "zone"
  phase       = "http_request_firewall_managed"

  rules = [{
    action      = "execute"
    description = "Execute the approved Cloudflare managed ruleset."
    enabled     = true
    expression  = local.host_expression
    ref         = "meltiply-managed-waf"
    action_parameters = {
      id = var.managed_waf_ruleset_id
    }
  }]
}
