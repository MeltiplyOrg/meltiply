mock_provider "cloudflare" {}

override_data {
  target = module.hyperdrive.data.cloudflare_hyperdrive_config.authenticated
  values = {
    id = "11111111111111111111111111111111"
    caching = {
      disabled               = true
      max_age                = 0
      stale_while_revalidate = 0
    }
  }
}

override_data {
  target = module.hyperdrive.data.cloudflare_hyperdrive_config.system
  values = {
    id = "22222222222222222222222222222222"
    caching = {
      disabled               = true
      max_age                = 0
      stale_while_revalidate = 0
    }
  }
}

variables {
  account_id                         = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  authenticated_hyperdrive_config_id = "11111111111111111111111111111111"
  system_hyperdrive_config_id        = "22222222222222222222222222222222"
  zone_id                            = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}

run "staging_plan" {
  command = plan

  plan_options {
    refresh = false
  }

  assert {
    condition     = output.release_resources.environment == "staging"
    error_message = "The default infrastructure plan must target staging."
  }

  assert {
    condition     = output.release_resources.app_hostname == "staging.meltiply.com"
    error_message = "The staging plan must derive the dashboard/API hostname from app_url."
  }

  assert {
    condition     = output.worker_bindings.ASSETS == "meltiply-assets-staging"
    error_message = "The staging Worker bindings must retain the private asset bucket."
  }

  assert {
    condition = (
      output.worker_bindings.DB_AUTHENTICATED ==
      "11111111111111111111111111111111" &&
      output.worker_bindings.DB_SYSTEM ==
      "22222222222222222222222222222222"
    )
    error_message = "The staging plan must preserve distinct authenticated and system Hyperdrive bindings."
  }

  assert {
    condition = (
      length(output.worker_bindings.queues) == 11 &&
      output.worker_bindings.queues["publish-tiktok"] ==
      "meltiply-publish-tiktok-staging"
    )
    error_message = "The staging plan must include all bounded workload queues."
  }

  assert {
    condition     = output.operator_access_aud == null
    error_message = "Operator Access must remain disabled unless explicitly configured."
  }

  assert {
    condition = (
      !output.release_resources.app_custom_domains_attached &&
      !output.release_resources.queue_consumers_attached &&
      output.release_resources.queue_delivery_paused
    )
    error_message = "The default plan must bootstrap safely without Worker attachments and with Queue delivery paused."
  }

  assert {
    condition = (
      output.zone_security.manages_rulesets &&
      length(output.zone_security.entrypoints) == 1 &&
      output.zone_security.entrypoints["http_ratelimit"].expression == "(http.host eq \"staging.meltiply.com\" and starts_with(http.request.uri.path, \"/api/\"))"
    )
    error_message = "Existing staging must retain sole ownership and its original single-host rate protection by default."
  }
}

run "worker_integrations_attached_paused" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    attach_app_custom_domains = true
    attach_queue_consumers    = true
  }

  assert {
    condition = (
      output.release_resources.app_custom_domains_attached &&
      output.release_resources.queue_consumers_attached &&
      output.release_resources.queue_delivery_paused
    )
    error_message = "Worker integrations must support attachment while Queue delivery remains paused for rollout checks."
  }
}

run "queue_delivery_activated" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    attach_queue_consumers = true
    queue_delivery_paused  = false
  }

  assert {
    condition = (
      output.release_resources.queue_consumers_attached &&
      !output.release_resources.queue_delivery_paused
    )
    error_message = "An accepted rollout must support explicitly resuming Queue delivery."
  }
}

run "preview_plan_rejected" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    environment          = "preview"
    manage_zone_security = true
  }

  expect_failures = [var.environment]
}

run "zero_rate_limit_rejected" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    rate_limit_requests_per_minute = 0
  }

  expect_failures = [var.rate_limit_requests_per_minute]
}

run "fractional_rate_limit_rejected" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    rate_limit_requests_per_minute = 120.5
  }

  expect_failures = [var.rate_limit_requests_per_minute]
}

run "incomplete_operator_access_rejected" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    enable_operator_access = true
  }

  expect_failures = [var.enable_operator_access]
}

run "operator_access_plan" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    access_team_domain     = "https://meltiply.cloudflareaccess.com"
    enable_operator_access = true
    operator_email_domains = ["example.test"]
  }

  assert {
    condition = (
      output.worker_bindings.ACCESS_TEAM_DOMAIN ==
      "https://meltiply.cloudflareaccess.com" &&
      output.worker_bindings.OPERATOR_HOSTNAME ==
      "ops.staging.meltiply.com"
    )
    error_message = "The enabled operator plan must export its exact Access issuer and hostname."
  }

  assert {
    condition     = output.operator_access_aud != null
    error_message = "The enabled operator plan must export an Access audience."
  }
}

run "production_plan" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    environment = "production"
    app_url     = "https://app.example.com"
    protected_app_hostnames = {
      staging    = "staging.example.com"
      production = "app.example.com"
    }
  }

  assert {
    condition = (
      output.release_resources.environment == "production" &&
      output.release_resources.assets_bucket_name == "meltiply-assets-production" &&
      output.release_resources.frontend_worker_name == "meltiply-frontend-production" &&
      output.release_resources.worker_names.api == "meltiply-api-production" &&
      output.release_resources.worker_names.automation == "meltiply-automation-production" &&
      output.release_resources.worker_names.state == "meltiply-state-production" &&
      output.worker_bindings.queues["publish-tiktok"] == "meltiply-publish-tiktok-production" &&
      output.release_resources.dead_letter_queue_names["publish-tiktok"] == "meltiply-publish-tiktok-production-dlq"
    )
    error_message = "Production resources and reviewed Worker identities must be isolated from legacy staging."
  }

  assert {
    condition     = length(output.zone_security.entrypoints) == 0
    error_message = "Production must not compete with the staging owner's zone entrypoints."
  }
}

run "production_frontend_wrong_suffix_rejected" {
  command = plan

  variables {
    environment          = "production"
    manage_zone_security = true
    frontend_worker_name = "meltiply-frontend"
  }

  expect_failures = [var.frontend_worker_name]
}

run "production_bucket_wrong_suffix_rejected" {
  command = plan

  variables {
    environment          = "production"
    manage_zone_security = true
    assets_bucket_name   = "meltiply-assets-staging"
  }

  expect_failures = [var.assets_bucket_name]
}

run "production_backend_wrong_suffix_rejected" {
  command = plan

  variables {
    environment            = "production"
    manage_zone_security   = true
    api_worker_name        = "meltiply-api"
    automation_worker_name = "meltiply-automation"
    state_worker_name      = "meltiply-state"
  }

  expect_failures = [var.api_worker_name, var.automation_worker_name, var.state_worker_name]
}

run "shared_zone_owner_protects_both_hosts" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    managed_waf_ruleset_id = "cccccccccccccccccccccccccccccccc"
    protected_app_hostnames = {
      staging    = "staging.meltiply.com"
      production = "app.meltiply.com"
    }
  }

  assert {
    condition = (
      output.zone_security.manages_rulesets &&
      length(output.zone_security.entrypoints) == 2 &&
      output.zone_security.entrypoints["http_ratelimit"].expression == "(http.host in {\"app.meltiply.com\" \"staging.meltiply.com\"} and starts_with(http.request.uri.path, \"/api/\"))" &&
      output.zone_security.entrypoints["http_request_firewall_managed"].expression == "http.host in {\"app.meltiply.com\" \"staging.meltiply.com\"}"
    )
    error_message = "One zone owner must rate-limit both API hosts and apply approved managed WAF protection to both hosts."
  }
}

run "shared_zone_non_owner_has_no_entrypoints" {
  command = plan

  variables {
    environment            = "production"
    app_url                = "https://app.meltiply.com"
    managed_waf_ruleset_id = "cccccccccccccccccccccccccccccccc"
    protected_app_hostnames = {
      staging    = "staging.meltiply.com"
      production = "app.meltiply.com"
    }
  }

  assert {
    condition = (
      !output.zone_security.manages_rulesets &&
      length(output.zone_security.entrypoints) == 0
    )
    error_message = "A non-owner must not create either zone entrypoint, even with a managed WAF ID configured."
  }
}

run "first_production_can_explicitly_own_zone" {
  command = plan

  variables {
    environment          = "production"
    app_url              = "https://app.example.com"
    manage_zone_security = true
  }

  assert {
    condition = (
      output.zone_security.manages_rulesets &&
      length(output.zone_security.entrypoints) == 1 &&
      output.zone_security.entrypoints["http_ratelimit"].expression == "(http.host eq \"app.example.com\" and starts_with(http.request.uri.path, \"/api/\"))"
    )
    error_message = "A first production installation without staging must explicitly own its zone security."
  }
}

run "non_owner_requires_explicit_hostname_coverage" {
  command = plan

  variables {
    environment = "production"
    app_url     = "https://app.example.com"
  }

  expect_failures = [var.protected_app_hostnames]
}

run "owner_cannot_omit_own_hostname" {
  command = plan

  variables {
    protected_app_hostnames = {
      production = "app.meltiply.com"
    }
  }

  expect_failures = [var.protected_app_hostnames]
}

run "non_owner_cannot_declare_different_hostname" {
  command = plan

  variables {
    environment = "production"
    app_url     = "https://app.example.com"
    protected_app_hostnames = {
      production = "other.example.com"
    }
  }

  expect_failures = [var.protected_app_hostnames]
}

run "hostname_expression_injection_rejected" {
  command = plan

  variables {
    protected_app_hostnames = {
      staging = "staging.meltiply.com\" or true"
    }
  }

  expect_failures = [var.protected_app_hostnames]
}

run "unsupported_protected_environment_rejected" {
  command = plan

  variables {
    protected_app_hostnames = {
      staging = "staging.meltiply.com"
      preview = "preview.meltiply.com"
    }
  }

  expect_failures = [var.protected_app_hostnames]
}

run "staging_can_explicitly_follow_production_owner" {
  command = plan

  variables {
    manage_zone_security = false
    protected_app_hostnames = {
      staging    = "staging.meltiply.com"
      production = "app.meltiply.com"
    }
  }

  assert {
    condition     = length(output.zone_security.entrypoints) == 0
    error_message = "First staging in a production-owned zone must be able to opt out of entrypoint ownership."
  }
}
