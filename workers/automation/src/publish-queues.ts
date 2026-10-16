import type { Platform } from "@meltiply/domain";

import type { AutomationEnv } from "./env";

/**
 * Resolves the dedicated Cloudflare Queue binding for a target social platform.
 * Provider publish queues are isolated per platform to prevent rate limits or backoff
 * on one provider from blocking publication throughput on others.
 *
 * @param env - Automation worker environment containing provider queue bindings.
 * @param platform - Target social platform ("facebook" | "instagram" | "threads" | "tiktok" | "youtube").
 * @returns The resolved platform Queue binding.
 * @throws {Error} When the required queue binding is not configured in the environment.
 */
export function publishingQueueFor(env: AutomationEnv, platform: Platform): Queue<unknown> {
  const queue = {
    facebook: env.FACEBOOK_PUBLISH_QUEUE,
    instagram: env.INSTAGRAM_PUBLISH_QUEUE,
    threads: env.THREADS_PUBLISH_QUEUE,
    tiktok: env.TIKTOK_PUBLISH_QUEUE,
    youtube: env.YOUTUBE_PUBLISH_QUEUE,
  }[platform];
  if (!queue) {
    throw new Error(`${platform} publish Queue binding is unavailable`);
  }
  return queue;
}
