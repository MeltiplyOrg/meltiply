import { describe, expect, it } from "vite-plus/test";

import {
  distributionTargetBlockReason,
  getAvailablePlatforms,
  oauthOutcomeMessage,
  platformDisplayName,
} from "./platforms";
import { contractSuccessBody } from "@/test/contract-fixtures";
import type { Asset, PlatformAccount, PlatformAccountsResponse } from "@/types";

const fixtureAsset = contractSuccessBody<{ attachments: { asset: Asset }[] }>("getPost")
  .attachments[0]!.asset;
const fixtureAccount =
  contractSuccessBody<PlatformAccountsResponse>("listPlatformAccounts").accounts[0]!;

const capabilities: PlatformAccount["capabilities"] = {
  ...fixtureAccount.capabilities,
  accepted_mime_types: ["image/png"],
  asset_types: ["image"],
  max_file_size: 100,
  max_video_duration_sec: 60,
  publish: true,
};
const account: PlatformAccount = {
  ...fixtureAccount,
  capabilities,
  connection_status: "connected",
  platform: "instagram",
};
const asset: Asset = {
  ...fixtureAsset,
  asset_type: "image",
  duration_sec: 60,
  file_size: 100,
  mime_type: "image/png",
};

describe("platformDisplayName", () => {
  it.each([
    ["tiktok", "TikTok"],
    ["youtube", "YouTube"],
    ["instagram", "Instagram"],
    ["facebook", "Facebook"],
    ["threads", "Threads"],
    ["unknown", "unknown"],
    ["constructor", "constructor"],
    ["__proto__", "__proto__"],
    ["toString", "toString"],
  ])("the platform %s", (platform, name) => {
    expect(platformDisplayName(platform)).toEqual(name);
  });
});

describe("getAvailablePlatforms", () => {
  it.each([
    ["nothing connected", [], ["tiktok", "youtube", "instagram", "facebook", "threads"]],
    ["two connected", ["tiktok", "instagram"], ["youtube", "facebook", "threads"]],
    ["all connected", ["tiktok", "youtube", "instagram", "facebook", "threads"], []],
  ])("%s", (_example, connected, available) => {
    expect(getAvailablePlatforms(connected)).toEqual(available);
  });
});

describe("distributionTargetBlockReason", () => {
  it.each([
    ["an asset on every limit", account, asset],
    ["an expiring connection", { ...account, connection_status: "expiring" as const }, asset],
    [
      "an asset of unknown size and length",
      account,
      { ...asset, duration_sec: null, file_size: null },
    ],
    [
      "an account without size or length limits",
      {
        ...account,
        capabilities: { ...capabilities, max_file_size: null, max_video_duration_sec: null },
      },
      { ...asset, duration_sec: 61, file_size: 101 },
    ],
    ["an asset without a media type", account, { ...asset, mime_type: null }],
    [
      "an account that lists no media types",
      { ...account, capabilities: { ...capabilities, accepted_mime_types: [] } },
      { ...asset, mime_type: "image/gif" },
    ],
  ])("%s", (_example, target, upload) => {
    expect(distributionTargetBlockReason(target, upload)).toEqual(null);
  });

  it.each([
    [
      "a connection that needs reconnecting",
      { ...account, connection_status: "reconnect_required" as const },
      asset,
      "Reconnect Instagram before publishing.",
    ],
    [
      "an account that cannot publish",
      { ...account, capabilities: { ...capabilities, publish: false } },
      asset,
      "Instagram publishing is not available for this account.",
    ],
    [
      "an asset type the account refuses",
      { ...account, capabilities: { ...capabilities, asset_types: ["video" as const] } },
      asset,
      "Instagram does not accept image assets.",
    ],
    [
      "a file one byte over the limit",
      account,
      { ...asset, file_size: 101 },
      "This asset exceeds the Instagram file-size limit.",
    ],
    [
      "a video one second over the limit",
      account,
      { ...asset, duration_sec: 61 },
      "This asset exceeds the Instagram video-duration limit.",
    ],
    [
      "a media type the account refuses",
      account,
      { ...asset, mime_type: "image/gif" },
      "Instagram does not accept this asset's media type.",
    ],
  ])("%s", (_example, target, upload, reason) => {
    expect(distributionTargetBlockReason(target, upload)).toEqual(reason);
  });
});

describe("oauthOutcomeMessage", () => {
  it.each([
    ["connected", "YouTube connected successfully."],
    [
      "connection_failed",
      "YouTube authorization succeeded, but the account could not be saved. Try connecting again.",
    ],
    ["consent_denied", "YouTube connection was cancelled before permission was granted."],
    [
      "missing_code",
      "YouTube connection could not be completed because the provider omitted its code.",
    ],
    [
      "provider_error",
      "YouTube connection could not be completed because the provider rejected the exchange.",
    ],
    ["provider_unavailable", "YouTube connection is not available yet."],
    [
      "selection_required",
      "YouTube authorization did not identify a single publishing account. Choose the intended account in the provider and try again.",
    ],
    [
      "state_invalid",
      "YouTube connection expired or could not be verified. Start again when the provider is available.",
    ],
  ])("the %s outcome", (outcome, message) => {
    expect(oauthOutcomeMessage(outcome, "youtube")).toEqual(message);
  });

  it.each([
    ["no outcome", null, "youtube"],
    ["no provider", "connected", null],
    ["an unknown outcome", "unknown", "youtube"],
    ["a constructor outcome", "constructor", "facebook"],
    ["a toString outcome", "toString", "facebook"],
    ["a prototype outcome", "__proto__", "facebook"],
  ])("%s", (_example, outcome, provider) => {
    expect(oauthOutcomeMessage(outcome, provider)).toEqual(null);
  });
});
