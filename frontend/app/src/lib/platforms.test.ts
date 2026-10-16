import { describe, expect, it } from "vite-plus/test";

import {
  distributionTargetBlockReason,
  getAvailablePlatforms,
  oauthOutcomeMessage,
  platformDisplayName,
} from "./platforms";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { Asset, PlatformAccountsResponse } from "@/types";

describe("platformDisplayName", () => {
  it("returns display name for known platforms", () => {
    expect(platformDisplayName("tiktok")).toBe("TikTok");
    expect(platformDisplayName("youtube")).toBe("YouTube");
    expect(platformDisplayName("instagram")).toBe("Instagram");
    expect(platformDisplayName("facebook")).toBe("Facebook");
    expect(platformDisplayName("threads")).toBe("Threads");
  });

  it("returns raw string for unknown platform", () => {
    expect(platformDisplayName("unknown")).toBe("unknown");
  });
});

describe("getAvailablePlatforms", () => {
  it("returns all platforms when none connected", () => {
    expect(getAvailablePlatforms([])).toEqual([
      "tiktok",
      "youtube",
      "instagram",
      "facebook",
      "threads",
    ]);
  });

  it("excludes connected platforms", () => {
    expect(getAvailablePlatforms(["tiktok", "instagram"])).toEqual([
      "youtube",
      "facebook",
      "threads",
    ]);
  });

  it("returns empty when all connected", () => {
    expect(
      getAvailablePlatforms(["tiktok", "youtube", "instagram", "facebook", "threads"]),
    ).toEqual([]);
  });
});

describe("distributionTargetBlockReason", () => {
  const attachment = contractSuccessBody<{ attachments: { asset: Asset }[] }>("getPost")
    .attachments[0]!;
  const account =
    contractSuccessBody<PlatformAccountsResponse>("listPlatformAccounts").accounts[0]!;

  it("accepts a connected account whose capability matches the attachment", () => {
    expect(distributionTargetBlockReason(account, attachment.asset)).toBeNull();
  });

  it("blocks unhealthy, unsupported, and over-limit targets with a specific reason", () => {
    expect(
      distributionTargetBlockReason(
        { ...account, connection_status: "reconnect_required" },
        attachment.asset,
      ),
    ).toContain("Reconnect");
    expect(
      distributionTargetBlockReason(
        {
          ...account,
          capabilities: { ...account.capabilities, asset_types: ["video"] },
        },
        attachment.asset,
      ),
    ).toContain("does not accept image assets");
    expect(
      distributionTargetBlockReason(
        {
          ...account,
          capabilities: { ...account.capabilities, max_file_size: 10 },
        },
        { ...attachment.asset, file_size: 11 },
      ),
    ).toContain("file-size limit");
  });
});

describe("oauthOutcomeMessage", () => {
  it("ignores incomplete or unknown callback values", () => {
    expect(oauthOutcomeMessage(null, "youtube")).toBeNull();
    expect(oauthOutcomeMessage("unknown", "youtube")).toBeNull();
    expect(oauthOutcomeMessage("constructor", "facebook")).toBeNull();
    expect(oauthOutcomeMessage("toString", "facebook")).toBeNull();
    expect(oauthOutcomeMessage("__proto__", "facebook")).toBeNull();
  });
});
