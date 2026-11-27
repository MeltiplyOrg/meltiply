import { PLATFORM_IDS, type Platform } from "@meltiply/domain";
import { beforeAll, describe, expect, it } from "vite-plus/test";

import {
  cachedProviderRegistryFromEnvironment,
  createProviderRegistryFromEnvironment,
  ProviderRegistry,
  type ProviderRegistryEnvironment,
} from "../src";
import type { ProviderAdapter } from "../src/types";
import { thrownBy } from "./support";

type Capability = ProviderAdapter["capability"];

const capability = (patch: Partial<Capability> = {}): Capability => ({
  accepted_mime_types: [],
  analytics: false,
  asset_types: [],
  comments: false,
  connect_available: false,
  max_caption_length: 500,
  max_file_size: null,
  max_hashtags: null,
  max_media_count: null,
  max_video_duration_sec: null,
  min_media_count: 0,
  multi_asset_types: [],
  notes: [],
  platform: "threads",
  publish: false,
  reply: false,
  ...patch,
});

const adapter = (patch: Partial<Capability> = {}, methods: Partial<ProviderAdapter> = {}) => ({
  capability: capability(patch),
  transferModes: [],
  ...methods,
});

const done = () => Promise.resolve({ outcome: "confirmed_success" } as const);
const publishing = {
  lookupPublication: () => Promise.resolve({ state: "not_found" } as const),
  publish: done,
  retryPolicy: { baseDelaySeconds: 15, maxAttempts: 5, maxDelaySeconds: 300 },
};

function registered(value: ProviderAdapter, platform: Platform = "threads") {
  const registry = new ProviderRegistry();
  registry.register(platform, value);
  return registry;
}

const unconfigured = (platform: Platform, captionLimit: number | null, analytics: boolean) => ({
  accepted_mime_types: [],
  analytics,
  asset_types: [],
  comments: false,
  connect_available: false,
  max_caption_length: captionLimit,
  max_file_size: null,
  max_hashtags: null,
  max_media_count: null,
  max_video_duration_sec: null,
  min_media_count: 0,
  multi_asset_types: [],
  notes: ["Provider adapter is not configured."],
  platform,
  publish: false,
  reply: false,
});

const roster = [
  ["tiktok", 4_000],
  ["youtube", 5_000],
  ["instagram", 2_200],
  ["facebook", null],
  ["threads", 500],
] as const;

const environments = {
  facebook: {
    FACEBOOK_CLIENT_ID: "id",
    FACEBOOK_CLIENT_SECRET: "secret",
    FACEBOOK_LIVE_ACCEPTED: "true",
  },
  instagram: {
    INSTAGRAM_CLIENT_ID: "id",
    INSTAGRAM_CLIENT_SECRET: "secret",
    INSTAGRAM_LIVE_ACCEPTED: "true",
  },
  threads: {
    THREADS_CLIENT_ID: "id",
    THREADS_CLIENT_SECRET: "secret",
    THREADS_LIVE_ACCEPTED: "true",
  },
  tiktok: { TIKTOK_CLIENT_KEY: "id", TIKTOK_CLIENT_SECRET: "secret", TIKTOK_LIVE_ACCEPTED: "true" },
  youtube: {
    YOUTUBE_SHORTS_CLIENT_ID: "id",
    YOUTUBE_SHORTS_CLIENT_SECRET: "secret",
    YOUTUBE_LIVE_ACCEPTED: "true",
  },
} satisfies Record<Platform, ProviderRegistryEnvironment>;

const APP_URL = "https://app.example.com/base";
const names = {
  facebook: "Facebook",
  instagram: "Instagram",
  threads: "Threads",
  tiktok: "TikTok",
  youtube: "YouTube",
};

beforeAll(() => {
  createProviderRegistryFromEnvironment({ APP_URL, ...environments.threads });
});

describe("ProviderRegistry", () => {
  describe("register", () => {
    it("a second adapter for a platform", () => {
      const registry = registered(adapter());

      expect(thrownBy(() => registry.register("threads", adapter()))).toEqual(
        new TypeError("provider adapter is already registered: threads"),
      );
    });

    it.each([
      [
        "a mismatched platform",
        adapter({ platform: "tiktok" }),
        "provider adapter capability platform does not match registry key",
      ],
      [
        "publishing without a publish method",
        adapter({ publish: true }, { ...publishing, publish: undefined }),
        "publish capability requires publish and lookup adapters",
      ],
      [
        "publishing without a lookup",
        adapter({ publish: true }, { ...publishing, lookupPublication: undefined }),
        "publish capability requires publish and lookup adapters",
      ],
      [
        "publishing without a retry policy",
        adapter({ publish: true }, { ...publishing, retryPolicy: undefined }),
        "publish capability requires a retry policy",
      ],
      [
        "media publishing without a transfer mode",
        adapter({ publish: true, asset_types: ["image"] }, publishing),
        "media publish capability requires at least one transfer mode",
      ],
      [
        "connecting without OAuth methods",
        adapter({ connect_available: true }),
        "connect capability requires authorization and code-exchange adapters",
      ],
      [
        "analytics without a method",
        adapter({ analytics: true }),
        "analytics capability requires an analytics adapter",
      ],
      [
        "comments without a method",
        adapter({ comments: true }),
        "comments capability requires a comments adapter",
      ],
      [
        "replies without a method",
        adapter({ reply: true }),
        "reply capability requires a reply adapter",
      ],
    ])("%s", (_example, value, message) => {
      expect(thrownBy(() => registered(value))).toEqual(new TypeError(message));
    });

    it("TikTok publishing without creator requirements", () => {
      const value = adapter({ platform: "tiktok", publish: true }, publishing);

      expect(thrownBy(() => registered(value, "tiktok"))).toEqual(
        new TypeError("TikTok publish capability requires publication requirements"),
      );
    });

    it.each([
      ["the smallest retry policy", 1, 1, 1],
      ["the largest retry policy", 3_600, 10, 86_400],
    ])("%s", (_example, baseDelaySeconds, maxAttempts, maxDelaySeconds) => {
      const retryPolicy = { baseDelaySeconds, maxAttempts, maxDelaySeconds };

      const registry = registered(adapter({}, { retryPolicy }));

      expect(registry.get("threads")?.retryPolicy).toEqual(retryPolicy);
    });

    it.each([
      ["no attempt", 1, 0, 1],
      ["eleven attempts", 1, 11, 1],
      ["a fractional attempt count", 1, 1.5, 2],
      ["no base delay", 0, 1, 1],
      ["a base delay over an hour", 3_601, 1, 3_601],
      ["a fractional base delay", 1.5, 1, 2],
      ["a maximum under the base", 300, 5, 299],
      ["a maximum over a day", 1, 1, 86_401],
      ["a fractional maximum", 1, 1, 1.5],
    ])("a retry policy with %s", (_example, baseDelaySeconds, maxAttempts, maxDelaySeconds) => {
      const retryPolicy = { baseDelaySeconds, maxAttempts, maxDelaySeconds };

      expect(thrownBy(() => registered(adapter({}, { retryPolicy })))).toEqual(
        new TypeError("provider retry policy is outside safe bounds"),
      );
    });

    it("a capability the caller later changes", () => {
      const value = adapter({ notes: ["a"] });

      const registry = registered(value);
      value.capability.notes.push("b");

      expect(registry.get("threads")?.capability.notes).toEqual(["a"]);
    });
  });

  describe("get", () => {
    it("an unregistered platform", () => {
      expect(new ProviderRegistry().get("threads")).toEqual(undefined);
    });

    it.each(["publish", "cancelPublication", "reply", "lookupPublication"] as const)(
      "%s adds the call's metadata to its result and clears stale metadata",
      async (method) => {
        const metadata = {
          rateLimitBudget: { percentUsed: 80, remaining: 4, resetsInSeconds: 30 },
        };
        let calls = 0;
        const value = adapter(
          {},
          {
            [method]: (context: { metadata?: unknown }) => {
              calls += 1;
              if (calls === 1) context.metadata = metadata;
              return Promise.resolve({ outcome: "confirmed_success" });
            },
          },
        );
        const call = registered(value).get("threads")![method] as (
          context: object,
        ) => Promise<unknown>;
        const context = { operationId: "o", requestId: "r" };

        const first = await call(context);
        const second = await call(context);

        expect(first).toEqual({ outcome: "confirmed_success", metadata });
        expect(second).toEqual({ outcome: "confirmed_success" });
      },
    );
  });

  describe("ambiguousZeroMetrics", () => {
    it.each([
      [
        "an adapter that declares them",
        registered(adapter({}, { ambiguousZeroMetrics: ["views"] })),
        ["views"],
      ],
      ["an adapter that declares none", registered(adapter()), []],
      ["an unregistered platform", new ProviderRegistry(), []],
    ])("%s", (_example, registry, metrics) => {
      expect(registry.ambiguousZeroMetrics("threads")).toEqual(metrics);
    });
  });

  describe("capabilities", () => {
    it("with no adapter", () => {
      expect(new ProviderRegistry().capabilities()).toEqual(
        roster.map(([platform, limit]) => unconfigured(platform, limit, true)),
      );
    });

    it("with one adapter", () => {
      expect(registered(adapter()).capabilities()).toEqual([
        ...roster.slice(0, 4).map(([platform, limit]) => unconfigured(platform, limit, false)),
        capability(),
      ]);
    });

    it("hands out one frozen descriptor", () => {
      const registry = new ProviderRegistry();

      const [first] = registry.capabilities();

      expect(registry.capabilities()[0]).toBe(first);
      expect(
        [first, first!.accepted_mime_types, first!.asset_types, first!.notes].map((value) =>
          Object.isFrozen(value),
        ),
      ).toEqual([true, true, true, true]);
    });
  });
});

describe("createProviderRegistryFromEnvironment", () => {
  const registeredPlatforms = (environment: ProviderRegistryEnvironment) => {
    const registry = createProviderRegistryFromEnvironment(environment);
    return PLATFORM_IDS.filter((platform) => registry.get(platform));
  };

  it.each([undefined, "", "false"])("a live acceptance flag of %s", (flag) => {
    const environment = {
      APP_URL,
      ...environments.threads,
      THREADS_LIVE_ACCEPTED: flag,
    };

    expect(registeredPlatforms(environment)).toEqual([]);
  });

  it.each(PLATFORM_IDS)("an accepted %s", (platform) => {
    expect(registeredPlatforms({ APP_URL, ...environments[platform] })).toEqual([platform]);
  });

  it.each(PLATFORM_IDS)("the %s authorization callback", (platform) => {
    const redirectUri = `https://app.example.com/api/v1/platforms/${platform}/callback`;
    const registry = createProviderRegistryFromEnvironment({ APP_URL, ...environments[platform] });

    const url = registry.get(platform)!.authorizationUrl!({
      codeChallenge: "a".repeat(43),
      redirectUri,
      state: "state",
    });

    expect(new URL(url).searchParams.get("redirect_uri")).toEqual(redirectUri);
  });

  it.each(PLATFORM_IDS)("an accepted %s without credentials", (platform) => {
    const environment = { APP_URL, [`${platform.toUpperCase()}_LIVE_ACCEPTED`]: "true" };

    expect(thrownBy(() => createProviderRegistryFromEnvironment(environment))).toEqual(
      new TypeError(`accepted ${names[platform]} provider configuration is incomplete`),
    );
  });

  it.each(PLATFORM_IDS)("a %s flag that is not boolean", (platform) => {
    const name = `${platform.toUpperCase()}_LIVE_ACCEPTED`;

    expect(thrownBy(() => createProviderRegistryFromEnvironment({ [name]: "yes" }))).toEqual(
      new TypeError(`${name} must be true or false`),
    );
  });

  it.each(["INSTAGRAM", "THREADS"])("%s engagement without publishing acceptance", (prefix) => {
    const environment = { [`${prefix}_ENGAGEMENT_LIVE_ACCEPTED`]: "true" };

    expect(thrownBy(() => createProviderRegistryFromEnvironment(environment))).toEqual(
      new TypeError(`${prefix}_ENGAGEMENT_LIVE_ACCEPTED requires ${prefix}_LIVE_ACCEPTED=true`),
    );
  });

  it.each(["INSTAGRAM", "THREADS"])("a %s engagement flag that is not boolean", (prefix) => {
    const name = `${prefix}_ENGAGEMENT_LIVE_ACCEPTED`;

    expect(thrownBy(() => createProviderRegistryFromEnvironment({ [name]: "yes" }))).toEqual(
      new TypeError(`${name} must be true or false`),
    );
  });

  it.each([
    ["instagram", "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED", undefined, false],
    ["instagram", "INSTAGRAM_ENGAGEMENT_LIVE_ACCEPTED", "true", true],
    ["threads", "THREADS_ENGAGEMENT_LIVE_ACCEPTED", undefined, false],
    ["threads", "THREADS_ENGAGEMENT_LIVE_ACCEPTED", "true", true],
  ] as const)("%s with %s %s", (platform, name, value, engagement) => {
    const environment = { APP_URL, ...environments[platform], [name]: value };

    const provider = createProviderRegistryFromEnvironment(environment).get(platform)!;

    expect(provider.capability.comments).toEqual(engagement);
    expect(provider.capability.reply).toEqual(engagement);
    expect(typeof provider.listComments === "function").toEqual(engagement);
    expect(typeof provider.reply === "function").toEqual(engagement);
  });

  it.each([
    ["tiktok", true, ["image", "video"]],
    ["youtube", true, ["video"]],
  ] as const)("the %s capability", (platform, analytics, assetTypes) => {
    const provider = createProviderRegistryFromEnvironment({
      APP_URL,
      ...environments[platform],
    }).get(platform)!;

    const { capability: registeredCapability } = provider;

    expect({
      analytics: registeredCapability.analytics,
      asset_types: registeredCapability.asset_types,
      comments: registeredCapability.comments,
      connect_available: registeredCapability.connect_available,
      publish: registeredCapability.publish,
      reply: registeredCapability.reply,
    }).toEqual({
      analytics,
      asset_types: assetTypes,
      comments: false,
      connect_available: true,
      publish: true,
      reply: false,
    });
  });

  it.each([
    ["no APP_URL", undefined, "accepted provider configuration is incomplete"],
    [
      "an APP_URL with credentials",
      "https://u:p@app.example.com",
      "APP_URL must be HTTPS or an exact loopback HTTP URL",
    ],
  ])("%s", (_example, appUrl, message) => {
    const environment = { APP_URL: appUrl, ...environments.threads };

    expect(thrownBy(() => createProviderRegistryFromEnvironment(environment))).toEqual(
      new TypeError(message),
    );
  });
});

describe("cachedProviderRegistryFromEnvironment", () => {
  it("the same environment twice", () => {
    const environment = { APP_URL, ...environments.threads };

    const first = cachedProviderRegistryFromEnvironment(environment);

    expect(cachedProviderRegistryFromEnvironment(environment)).toBe(first);
  });

  it("a flag changed on the same environment", () => {
    const environment = { APP_URL, ...environments.threads };
    cachedProviderRegistryFromEnvironment(environment);

    environment.THREADS_LIVE_ACCEPTED = "false";

    expect(cachedProviderRegistryFromEnvironment(environment).get("threads")).toEqual(undefined);
  });
});
