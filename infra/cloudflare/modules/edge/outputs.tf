output "api_hostname" {
  description = "Configured API hostname, whether or not it is attached yet."
  value       = var.api_hostname
}

output "custom_domain_id" {
  description = "Cloudflare custom-domain resource ID."
  value       = var.attach_custom_domains ? cloudflare_workers_custom_domain.api[0].id : null
}

output "custom_domains_attached" {
  description = "Whether API and eligible operator custom domains are attached."
  value       = var.attach_custom_domains
}
