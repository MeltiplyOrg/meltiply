output "bucket_name" {
  description = "R2 bucket bound to the API and Automation Workers."
  value       = cloudflare_r2_bucket.assets.name
}
