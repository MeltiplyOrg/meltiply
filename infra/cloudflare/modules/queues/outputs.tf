output "queue_ids" {
  description = "Workload queue IDs keyed by workload."
  value = {
    for name, queue in cloudflare_queue.workload : name => queue.queue_id
  }
}

output "queue_names" {
  description = "Workload queue names keyed by workload."
  value       = local.queue_names
}

output "dead_letter_queue_names" {
  description = "DLQ names keyed by workload."
  value       = local.dlq_names
}

output "dead_letter_queue_ids" {
  description = "DLQ IDs keyed by workload for metrics and audited replay tooling."
  value = {
    for name, queue in cloudflare_queue.dead_letter : name => queue.queue_id
  }
}

output "consumers_attached" {
  description = "Whether workload consumers are attached to the Automation Worker."
  value       = var.attach_consumers
}

output "delivery_paused" {
  description = "Whether workload Queue delivery is paused."
  value       = var.delivery_paused
}
