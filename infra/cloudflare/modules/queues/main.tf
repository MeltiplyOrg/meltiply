locals {
  queue_names = {
    for workload in keys(var.workloads) :
    workload => "meltiply-${workload}-${var.environment}"
  }
  dlq_names = {
    for workload in keys(var.workloads) :
    workload => "meltiply-${workload}-${var.environment}-dlq"
  }
}
# The Automation Worker's provider attempt lease
# (workers/automation/src/due-work.ts, providerAttemptLeaseSeconds) is
# derived from the 120-second visibility timeout shared by the analytics,
# comments, and token-refresh workloads and must stay shorter than every queue
# visibility timeout that carries provider sync messages, so a redelivered
# message always arrives after its claim's lease has lapsed and fails the
# Worker's event-key guard instead of reprocessing the work.
locals {
  # Expressed in milliseconds because that is the unit of the consumer's
  # visibility_timeout_ms setting the precondition below compares it against;
  # comparing against seconds would make the precondition vacuously true and
  # silently stop enforcing the inequality.
  provider_attempt_lease_ms = 60 * 1000
}

resource "cloudflare_queue" "workload" {
  for_each = var.workloads

  lifecycle {
    prevent_destroy = true
  }

  account_id = var.account_id
  queue_name = local.queue_names[each.key]
  settings = {
    delivery_delay           = 0
    delivery_paused          = var.delivery_paused
    message_retention_period = 1209600
  }
}

resource "cloudflare_queue" "dead_letter" {
  for_each = var.workloads

  lifecycle {
    prevent_destroy = true
  }

  account_id = var.account_id
  queue_name = local.dlq_names[each.key]
  settings = {
    delivery_delay           = 0
    delivery_paused          = false
    message_retention_period = 1209600
  }
}

resource "cloudflare_queue_consumer" "workload" {
  for_each = var.attach_consumers ? var.workloads : {}

  account_id        = var.account_id
  queue_id          = cloudflare_queue.workload[each.key].queue_id
  type              = "worker"
  script_name       = var.automation_worker_name
  dead_letter_queue = cloudflare_queue.dead_letter[each.key].queue_name
  settings = {
    batch_size            = each.value.batch_size
    max_concurrency       = each.value.max_concurrency
    max_retries           = each.value.max_retries
    max_wait_time_ms      = each.value.max_wait_time_ms
    retry_delay           = each.value.retry_delay_seconds
    visibility_timeout_ms = each.value.visibility_timeout_ms
  }

  lifecycle {
    precondition {
      condition = (!contains(["analytics", "comments", "token-refresh"], each.key)
        ? true
      : each.value.visibility_timeout_ms > local.provider_attempt_lease_ms)
      error_message = "Provider sync consumers must keep visibility_timeout_ms greater than the Automation provider attempt lease so redelivered messages fail the event-key guard instead of reprocessing."
    }
  }
}

resource "cloudflare_queue_consumer" "dead_letter_pull" {
  for_each = var.workloads

  account_id = var.account_id
  queue_id   = cloudflare_queue.dead_letter[each.key].queue_id
  type       = "http_pull"
  settings = {
    batch_size            = 100
    retry_delay           = 60
    visibility_timeout_ms = 300000
  }
}
