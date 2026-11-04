output "app_hostname" {
  description = "Configured dashboard/API hostname, whether or not it is attached yet."
  value       = var.app_hostname
}

output "custom_domain_id" {
  description = "Cloudflare custom-domain resource ID."
  value       = var.attach_custom_domains ? cloudflare_workers_custom_domain.api[0].id : null
}

output "custom_domains_attached" {
  description = "Whether API and eligible operator custom domains are attached."
  value       = var.attach_custom_domains
}

output "zone_security" {
  description = "Declared zone coverage and entrypoints actually owned by this state; non-owners must verify the applied owner's output."
  value = {
    zone_id                 = var.zone_id
    manages_rulesets        = var.manage_zone_security
    protected_app_hostnames = var.protected_app_hostnames
    entrypoints = merge(
      { for ruleset in cloudflare_ruleset.rate_limit : ruleset.phase => {
        id         = ruleset.id
        expression = ruleset.rules[0].expression
      } },
      { for ruleset in cloudflare_ruleset.managed_waf : ruleset.phase => {
        id         = ruleset.id
        expression = ruleset.rules[0].expression
      } }
    )
  }
}
