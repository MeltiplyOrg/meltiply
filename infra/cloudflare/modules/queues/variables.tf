variable "account_id" {
  description = "Cloudflare account identifier."
  type        = string
}

variable "attach_consumers" {
  description = "Whether to attach workload consumers to the deployed Automation Worker."
  type        = bool
}

variable "automation_worker_name" {
  description = "Deployed Worker that consumes every workload queue."
  type        = string
}

variable "delivery_paused" {
  description = "Whether workload Queue delivery remains paused during bootstrap or rollout."
  type        = bool
}

variable "environment" {
  description = "Deployment environment name used in resource names."
  type        = string
}

variable "workloads" {
  description = "Queue consumer settings keyed by stable workload name."
  type = map(object({
    batch_size            = optional(number, 10)
    max_concurrency       = optional(number, 5)
    max_retries           = optional(number, 3)
    max_wait_time_ms      = optional(number, 5000)
    retry_delay_seconds   = optional(number, 5)
    visibility_timeout_ms = optional(number, 30000)
  }))

  validation {
    condition = length(var.workloads) > 0 && alltrue([
      for name, settings in var.workloads :
      can(regex("^[a-z][a-z0-9-]+$", name)) &&
      settings.batch_size >= 1 &&
      settings.batch_size <= 100 &&
      settings.max_concurrency >= 1 &&
      settings.max_concurrency <= 20 &&
      settings.max_retries >= 1 &&
      settings.max_retries <= 100 &&
      settings.max_wait_time_ms >= 0 &&
      settings.max_wait_time_ms <= 60000 &&
      settings.retry_delay_seconds >= 0 &&
      settings.retry_delay_seconds <= 43200 &&
      settings.visibility_timeout_ms >= 1000 &&
      settings.visibility_timeout_ms <= 43200000
    ])
    error_message = "Queue names and batch, concurrency, retry, wait, delay, and visibility settings must be valid and bounded."
  }
}
