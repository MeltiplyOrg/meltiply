import { PLATFORM_IDS, type Platform } from "@meltiply/domain";
import { describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { publishingQueueFor } from "../src/publish-queues";
import { fakeQueue } from "./test-doubles";

const queues = {
  facebook: fakeQueue(),
  instagram: fakeQueue(),
  threads: fakeQueue(),
  tiktok: fakeQueue(),
  youtube: fakeQueue(),
} satisfies Record<Platform, Queue<unknown>>;

const fullEnv: AutomationEnv = {
  ENVIRONMENT: "test",
  FACEBOOK_PUBLISH_QUEUE: queues.facebook,
  INSTAGRAM_PUBLISH_QUEUE: queues.instagram,
  THREADS_PUBLISH_QUEUE: queues.threads,
  TIKTOK_PUBLISH_QUEUE: queues.tiktok,
  VERSION: "test",
  YOUTUBE_PUBLISH_QUEUE: queues.youtube,
};

describe("publishingQueueFor", () => {
  it.each(PLATFORM_IDS)("routes %s to its dedicated publish Queue binding", (platform) => {
    expect(publishingQueueFor(fullEnv, platform)).toBe(queues[platform]);
  });

  it("fails closed when the platform publish Queue binding is unavailable", () => {
    expect(() => publishingQueueFor({ ENVIRONMENT: "test", VERSION: "test" }, "tiktok")).toThrow(
      "tiktok publish Queue binding is unavailable",
    );
  });
});
