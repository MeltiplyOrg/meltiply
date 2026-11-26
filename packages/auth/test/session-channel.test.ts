import { describe, expect, it } from "vite-plus/test";

import { clientChannelFor } from "../src/session-channel";

const ownWeb = { clientChannel: "web", userId: "user-1" } as const;
const ownCli = { clientChannel: "cli", userId: "user-1" } as const;
const someoneElses = { clientChannel: "cli", userId: "user-2" } as const;

describe("clientChannelFor", () => {
  it.each([
    ["the device token endpoint over a web predecessor", "/device/token", ownWeb, "cli"],
    ["a predecessor session of the same user", "/change-password", ownCli, "cli"],
    ["a sign-in", "/sign-in/email", undefined, "web"],
    ["a sign-up", "/sign-up/email", undefined, "web"],
    ["an email verification", "/verify-email", undefined, "web"],
    ["a second factor check", "/two-factor/verify-totp", undefined, "web"],
    ["a sign-in beside another user's session", "/sign-in/email", someoneElses, "web"],
    ["another endpoint", "/change-password", undefined, "unknown"],
    ["another user's predecessor", "/change-password", someoneElses, "unknown"],
    ["no endpoint", undefined, undefined, "unknown"],
  ] as const)("%s", (_example, path, provenance, channel) => {
    expect(clientChannelFor(path, provenance, "user-1")).toEqual(channel);
  });
});
