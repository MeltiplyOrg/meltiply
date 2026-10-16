terraform {
  # The protected state service supplies address, lock_address,
  # unlock_address, and credentials through backend config/environment.
  # No credential or state endpoint is committed.
  backend "http" {}
}
