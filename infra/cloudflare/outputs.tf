output "release_resources" {
  description = "Non-secret resource identifiers included in each release manifest."
  value = {
    app_hostname                = module.edge.app_hostname
    app_custom_domains_attached = module.edge.custom_domains_attached
    assets_bucket_name          = module.storage.bucket_name
    authenticated_hyperdrive_id = module.hyperdrive.authenticated_config_id
    dead_letter_queue_ids       = module.queues.dead_letter_queue_ids
    dead_letter_queue_names     = module.queues.dead_letter_queue_names
    environment                 = var.environment
    operator_access_aud         = var.enable_operator_access ? module.operator_access[0].application_aud : null
    operator_hostname           = var.enable_operator_access ? var.operator_hostname : null
    queue_consumers_attached    = module.queues.consumers_attached
    queue_delivery_paused       = module.queues.delivery_paused
    queue_names                 = module.queues.queue_names
    system_hyperdrive_id        = module.hyperdrive.system_config_id
  }
}

output "worker_bindings" {
  description = "IaC-owned resource IDs/names copied into protected deployment configuration."
  value = {
    ASSETS             = module.storage.bucket_name
    DB_AUTHENTICATED   = module.hyperdrive.authenticated_config_id
    DB_SYSTEM          = module.hyperdrive.system_config_id
    ACCESS_POLICY_AUD  = var.enable_operator_access ? module.operator_access[0].application_aud : null
    ACCESS_TEAM_DOMAIN = var.enable_operator_access ? var.access_team_domain : null
    OPERATOR_HOSTNAME  = var.enable_operator_access ? var.operator_hostname : null
    queues             = module.queues.queue_names
  }
}

output "operator_access_aud" {
  description = "Access application audience for Worker JWT verification."
  value = (
    var.enable_operator_access
    ? module.operator_access[0].application_aud
    : null
  )
}
