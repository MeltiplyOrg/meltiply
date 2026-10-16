output "authenticated_config_id" {
  description = "Validated authenticated-role Hyperdrive configuration ID."
  value       = data.cloudflare_hyperdrive_config.authenticated.id
}

output "system_config_id" {
  description = "Validated system-role Hyperdrive configuration ID."
  value       = data.cloudflare_hyperdrive_config.system.id
}
