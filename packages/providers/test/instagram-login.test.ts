import { describe, expect, it } from "vite-plus/test";

import {
  instagramAccount,
  instagramGrantedPermissions,
  instagramLoginRecord,
} from "../src/instagram/login";
import { failureThrownBy, malformedAnswer } from "./support";

const profile = { account_type: "Business", id: "1", user_id: "178", username: "creator" };
const account = { displayName: "creator", id: "178", username: "creator" };

describe("instagramLoginRecord", () => {
  it.each([
    ["a plain body", { a: 1 }],
    ["an enveloped account", { data: [{ a: 1 }] }],
  ])("%s", (_example, value) => {
    expect(instagramLoginRecord(value)).toEqual({ a: 1 });
  });

  it.each([
    ["a body that is not an object", "x"],
    ["an envelope that is not a list", { data: {} }],
    ["two enveloped accounts", { data: [{}, {}] }],
    ["an enveloped entry that is not an object", { data: ["x"] }],
  ])("refuses %s", (_example, value) => {
    expect(failureThrownBy(() => instagramLoginRecord(value))).toEqual(malformedAnswer);
  });
});

describe("instagramGrantedPermissions", () => {
  it.each([
    ["a list", ["a", "b"], ["a", "b"]],
    ["a comma-separated string", "a, b", ["a", "b"]],
    ["a list entry that is not text", ["a", null], ["a", undefined]],
    ["32 entries", Array.from({ length: 32 }, () => "a"), Array.from({ length: 32 }, () => "a")],
    ["33 entries", Array.from({ length: 33 }, () => "a"), undefined],
    ["a value that is not text", 5, undefined],
  ])("%s", (_example, value, permissions) => {
    expect(instagramGrantedPermissions(value)).toEqual(permissions);
  });
});

describe("instagramAccount", () => {
  it("a profile with a name and a picture", () => {
    const full = { ...profile, name: "Creator Name", profile_picture_url: "https://cdn.test/a" };

    expect(instagramAccount(full)).toEqual({
      avatarUrl: "https://cdn.test/a",
      displayName: "Creator Name",
      id: "178",
      username: "creator",
    });
  });

  it.each(["BUSINESS", "Media_Creator"])("a %s account named by its username", (type) => {
    expect(instagramAccount({ ...profile, account_type: type })).toEqual(account);
  });

  it.each([
    ["a personal account", { account_type: "PERSONAL" }],
    ["a blank login ID", { id: "" }],
    ["no professional user ID", { user_id: undefined }],
    ["no username", { username: undefined }],
    ["an insecure picture", { profile_picture_url: "http://cdn.test/a" }],
  ])("refuses %s", (_example, patch) => {
    expect(failureThrownBy(() => instagramAccount({ ...profile, ...patch }))).toEqual(
      malformedAnswer,
    );
  });
});
