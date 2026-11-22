import type { Platform } from "@meltiply/domain";

import type { AutomationEnv } from "./env";

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
