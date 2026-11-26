import { describe, expect, it } from "vite-plus/test";

import {
  cachedProviderRegistryFromEnvironment,
  createProviderRegistryFromEnvironment,
} from "../src";
import { overriddenUrl, providerOriginOverrides, redirectingFetch } from "../src/origin-overrides";

const FAKE = "http://127.0.0.1:4010";

describe("providerOriginOverrides", () => {
  it("no setting", () => {
    expect(providerOriginOverrides({})).toEqual(new Map());
  });

  it("a blank setting", () => {
    expect(providerOriginOverrides({ PROVIDER_ORIGIN_TIKTOK_API: "  " })).toEqual(new Map());
  });

  it("every setting", () => {
    const environment = {
      PROVIDER_ORIGIN_FACEBOOK_GRAPH: "http://localhost:1",
      PROVIDER_ORIGIN_FACEBOOK_UPLOAD: "http://localhost:2",
      PROVIDER_ORIGIN_INSTAGRAM_API: "http://localhost:3",
      PROVIDER_ORIGIN_INSTAGRAM_GRAPH: "http://localhost:4",
      PROVIDER_ORIGIN_THREADS_GRAPH: "http://localhost:5",
      PROVIDER_ORIGIN_TIKTOK_API: "http://localhost:6",
      PROVIDER_ORIGIN_YOUTUBE_ANALYTICS: "http://localhost:7",
      PROVIDER_ORIGIN_YOUTUBE_API: "http://localhost:8",
      PROVIDER_ORIGIN_YOUTUBE_TOKEN: " http://127.0.0.1:9/ ",
    };

    expect(providerOriginOverrides(environment)).toEqual(
      new Map([
        ["https://graph.facebook.com", "http://localhost:1"],
        ["https://rupload.facebook.com", "http://localhost:2"],
        ["https://api.instagram.com", "http://localhost:3"],
        ["https://graph.instagram.com", "http://localhost:4"],
        ["https://graph.threads.com", "http://localhost:5"],
        ["https://open.tiktokapis.com", "http://localhost:6"],
        ["https://youtubeanalytics.googleapis.com", "http://localhost:7"],
        ["https://www.googleapis.com", "http://localhost:8"],
        ["https://oauth2.googleapis.com", "http://127.0.0.1:9"],
      ]),
    );
  });

  it.each([
    ["a remote host", "http://evil.example"],
    ["a host that only starts like loopback", "http://127.0.0.1.evil.example"],
    ["https on loopback", "https://127.0.0.1:4010"],
    ["a path", "http://127.0.0.1:4010/api"],
    ["a query", "http://127.0.0.1:4010/?a=1"],
    ["a username", "http://user@127.0.0.1:4010"],
    ["text that is not a URL", "localhost"],
  ])("%s", (_example, value) => {
    expect(() => providerOriginOverrides({ PROVIDER_ORIGIN_TIKTOK_API: value })).toThrow(
      new TypeError("PROVIDER_ORIGIN_TIKTOK_API must be a loopback HTTP origin"),
    );
  });
});

describe("overriddenUrl", () => {
  const overrides = new Map([["https://graph.threads.com", FAKE]]);

  it.each([
    [
      "an overridden origin",
      "https://graph.threads.com/v1.0/me?fields=id",
      `${FAKE}/v1.0/me?fields=id`,
    ],
    ["another origin", "https://graph.facebook.com/me", "https://graph.facebook.com/me"],
  ])("%s", (_example, url, expected) => {
    expect(overriddenUrl(url, overrides)).toEqual(expected);
  });
});

describe("redirectingFetch", () => {
  it("a request for an overridden origin", async () => {
    const sent: unknown[] = [];
    const send: typeof fetch = (input, init) => {
      sent.push([input, init]);
      return Promise.resolve(new Response("ok"));
    };

    await redirectingFetch(new Map([["https://graph.threads.com", FAKE]]), send)(
      new URL("https://graph.threads.com/me"),
      { method: "POST" },
    );

    expect(sent).toEqual([[`${FAKE}/me`, { method: "POST" }]]);
  });
});

describe("createProviderRegistryFromEnvironment origin settings", () => {
  const environment = {
    APP_URL: "https://app.meltiply.com",
    TIKTOK_CLIENT_KEY: "key",
    TIKTOK_CLIENT_SECRET: "secret",
    TIKTOK_LIVE_ACCEPTED: "true",
  };

  async function revokedAt(settings: Record<string, string>) {
    const urls: string[] = [];
    const registry = createProviderRegistryFromEnvironment(
      { ...environment, ...settings },
      {
        fetch: (input) => {
          urls.push(String(input));
          return Promise.resolve(Response.json({}));
        },
      },
    );
    await registry.get("tiktok")!.revoke!("access-token");
    return urls;
  }

  it("unset", async () => {
    expect(await revokedAt({})).toEqual(["https://open.tiktokapis.com/v2/oauth/revoke/"]);
  });

  it("set", async () => {
    expect(await revokedAt({ PROVIDER_ORIGIN_TIKTOK_API: FAKE })).toEqual([
      `${FAKE}/v2/oauth/revoke/`,
    ]);
  });
});

describe("cachedProviderRegistryFromEnvironment origin settings", () => {
  it("a setting changed on the same environment", () => {
    const environment: Record<string, string> = { APP_URL: "https://app.meltiply.com" };
    const first = cachedProviderRegistryFromEnvironment(environment);

    environment.PROVIDER_ORIGIN_TIKTOK_API = FAKE;

    expect(cachedProviderRegistryFromEnvironment(environment)).not.toBe(first);
  });
});
