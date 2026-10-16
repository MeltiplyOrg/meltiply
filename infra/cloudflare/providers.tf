provider "cloudflare" {
  # Read from CLOUDFLARE_API_TOKEN. The token is supplied by a protected CI
  # context and is never passed as a Terraform variable or persisted in state.
}
