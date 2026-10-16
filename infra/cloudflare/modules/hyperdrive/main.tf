# Hyperdrive origin passwords are write-only API values. Managing the
# configuration resource directly would persist those values in state, so a
# protected bootstrap command creates/rotates the configurations and this
# module validates their non-secret control plane properties by ID.
data "cloudflare_hyperdrive_config" "authenticated" {
  account_id    = var.account_id
  hyperdrive_id = var.authenticated_config_id
}

data "cloudflare_hyperdrive_config" "system" {
  account_id    = var.account_id
  hyperdrive_id = var.system_config_id
}

check "separate_roles" {
  assert {
    condition = (
      data.cloudflare_hyperdrive_config.authenticated.id !=
      data.cloudflare_hyperdrive_config.system.id
    )
    error_message = "System and authenticated Hyperdrive configurations must be distinct."
  }
}

check "authenticated_cache_disabled" {
  assert {
    condition     = data.cloudflare_hyperdrive_config.authenticated.caching.disabled
    error_message = "Authenticated/RLS Hyperdrive query caching must be disabled."
  }
}

check "system_cache_disabled" {
  assert {
    condition     = data.cloudflare_hyperdrive_config.system.caching.disabled
    error_message = "System Hyperdrive query caching remains disabled until freshness is proven."
  }
}
