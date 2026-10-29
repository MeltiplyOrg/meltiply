locals {
  assets_bucket_name   = coalesce(var.assets_bucket_name, "meltiply-assets-${var.environment}")
  frontend_worker_name = coalesce(var.frontend_worker_name, "meltiply-frontend-${var.environment}")

  manage_zone_security    = coalesce(var.manage_zone_security, var.environment == "staging")
  protected_app_hostnames = length(var.protected_app_hostnames) == 0 ? tomap({
    (var.environment) = trimprefix(var.app_url, "https://")
  }) : var.protected_app_hostnames
  # Preserve legacy staging services while keeping production independent in the same account.
  worker_suffix = var.environment == "staging" ? "" : "-${var.environment}"
  worker_names = {
    api        = coalesce(var.api_worker_name, "meltiply-api${local.worker_suffix}")
    automation = coalesce(var.automation_worker_name, "meltiply-automation${local.worker_suffix}")
    state      = coalesce(var.state_worker_name, "meltiply-state${local.worker_suffix}")
    frontend   = local.frontend_worker_name
  }
  workloads = {
    "analytics" = {
      batch_size            = 10
      max_concurrency       = 3
      max_retries           = 3
      visibility_timeout_ms = 120000
    }
    "asset-processing" = {
      batch_size      = 5
      max_concurrency = 4
      max_retries     = 3
    }
    "channel-revocation" = {
      batch_size      = 10
      max_concurrency = 3
      max_retries     = 3
    }
    "comments" = {
      batch_size            = 10
      max_concurrency       = 3
      max_retries           = 3
      visibility_timeout_ms = 120000
    }
    "publish-facebook" = {
      batch_size            = 5
      max_concurrency       = 1
      max_retries           = 5
      visibility_timeout_ms = 300000
    }
    "publish-instagram" = {
      batch_size            = 5
      max_concurrency       = 1
      max_retries           = 5
      visibility_timeout_ms = 300000
    }
    "publish-threads" = {
      batch_size            = 5
      max_concurrency       = 1
      max_retries           = 5
      visibility_timeout_ms = 300000
    }
    "publish-tiktok" = {
      batch_size            = 5
      max_concurrency       = 1
      max_retries           = 5
      visibility_timeout_ms = 300000
    }
    "publish-youtube" = {
      batch_size            = 5
      max_concurrency       = 1
      max_retries           = 5
      visibility_timeout_ms = 300000
    }
    "replies" = {
      batch_size      = 10
      max_concurrency = 3
      max_retries     = 3
    }
    "token-refresh" = {
      batch_size            = 10
      max_concurrency       = 2
      max_retries           = 3
      visibility_timeout_ms = 120000
    }
  }
}

module "queues" {
  source = "./modules/queues"

  account_id             = var.account_id
  attach_consumers       = var.attach_queue_consumers
  automation_worker_name = local.worker_names.automation
  delivery_paused        = var.queue_delivery_paused
  environment            = var.environment
  workloads              = local.workloads
}

module "storage" {
  source = "./modules/storage"

  account_id      = var.account_id
  allowed_origins = setunion([var.app_url], var.allowed_origins)
  bucket_name     = local.assets_bucket_name
}

module "hyperdrive" {
  source = "./modules/hyperdrive"

  account_id              = var.account_id
  authenticated_config_id = var.authenticated_hyperdrive_config_id
  system_config_id        = var.system_hyperdrive_config_id
}

module "edge" {
  source = "./modules/edge"

  account_id              = var.account_id
  app_hostname            = trimprefix(var.app_url, "https://")
  frontend_worker_name    = local.frontend_worker_name
  api_worker_name         = local.worker_names.api
  attach_custom_domains   = var.attach_app_custom_domains
  managed_waf_ruleset_id  = var.managed_waf_ruleset_id
  manage_zone_security    = local.manage_zone_security
  protected_app_hostnames = local.protected_app_hostnames
  operator_hostname       = var.enable_operator_access ? var.operator_hostname : null
  requests_per_minute     = var.rate_limit_requests_per_minute
  zone_id                 = var.zone_id
}

module "operator_access" {
  count  = var.enable_operator_access ? 1 : 0
  source = "./modules/access"

  account_id            = var.account_id
  allowed_email_domains = var.operator_email_domains
  application_domain    = var.operator_hostname
  application_name      = "Meltiply ${title(var.environment)} Operations"
  tags                  = var.common_tags
}
