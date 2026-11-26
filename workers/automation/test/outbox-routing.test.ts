import type { Platform } from "@meltiply/domain";
import { describe, expect, it } from "vite-plus/test";

import type { AutomationEnv } from "../src/env";
import { publishingQueueFor } from "../src/publish-queues";
import { fakeQueue } from "./test-doubles";

describe("provider-specific publish Queue routing", () => {
  it("isolates every provider on its own binding", () => {
    const queues = {
      facebook: fakeQueue(),
      instagram: fakeQueue(),
      threads: fakeQueue(),
      tiktok: fakeQueue(),
      youtube: fakeQueue(),
    } satisfies Record<Platform, Queue<unknown>>;
    const env: AutomationEnv = {
      ENVIRONMENT: "test",
      FACEBOOK_PUBLISH_QUEUE: queues.facebook,
      INSTAGRAM_PUBLISH_QUEUE: queues.instagram,
      THREADS_PUBLISH_QUEUE: queues.threads,
      TIKTOK_PUBLISH_QUEUE: queues.tiktok,
      VERSION: "test",
      YOUTUBE_PUBLISH_QUEUE: queues.youtube,
    };

    for (const platform of Object.keys(queues) as Platform[]) {
      expect(publishingQueueFor(env, platform)).toBe(queues[platform]);
    }
  });

  it("fails closed when one provider binding is unavailable", () => {
    expect(() => publishingQueueFor({ ENVIRONMENT: "test", VERSION: "test" }, "tiktok")).toThrow(
      "tiktok publish Queue binding is unavailable",
    );
  });
});
