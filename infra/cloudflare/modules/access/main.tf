resource "cloudflare_zero_trust_access_policy" "operators" {
  account_id       = var.account_id
  name             = "${var.application_name} operators"
  decision         = "allow"
  session_duration = "8h"

  include = [
    for domain in sort(tolist(var.allowed_email_domains)) : {
      email_domain = {
        domain = domain
      }
    }
  ]
}

resource "cloudflare_zero_trust_access_application" "operators" {
  account_id                 = var.account_id
  name                       = var.application_name
  domain                     = var.application_domain
  type                       = "self_hosted"
  session_duration           = "8h"
  auto_redirect_to_identity  = true
  enable_binding_cookie      = true
  http_only_cookie_attribute = true
  options_preflight_bypass   = false
  same_site_cookie_attribute = "strict"
  tags                       = var.tags

  policies = [{
    id = cloudflare_zero_trust_access_policy.operators.id
  }]
}
