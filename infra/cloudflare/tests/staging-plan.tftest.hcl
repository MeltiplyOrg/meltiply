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
  frontend_origins                   = ["https://staging.meltiply.com"]
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
    condition     = output.release_resources.api_hostname == "api.staging.meltiply.com"
    error_message = "The staging plan must expose the accepted API hostname."
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
      !output.release_resources.api_custom_domains_attached &&
      !output.release_resources.queue_consumers_attached &&
      output.release_resources.queue_delivery_paused
    )
    error_message = "The default plan must bootstrap safely without Worker attachments and with Queue delivery paused."
  }

}

run "worker_integrations_attached_paused" {
  command = plan

  plan_options {
    refresh = false
  }

  variables {
    attach_api_custom_domains = true
    attach_queue_consumers    = true
  }

  assert {
    condition = (
      output.release_resources.api_custom_domains_attached &&
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
    environment = "preview"
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
