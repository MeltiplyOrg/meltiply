output "application_id" {
  description = "Protected operator Access application ID."
  value       = cloudflare_zero_trust_access_application.operators.id
}

output "application_aud" {
  description = "Audience tag validated by the operator Worker route."
  value       = cloudflare_zero_trust_access_application.operators.aud
}
