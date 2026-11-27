import { describe, expect, it } from "vite-plus/test";

import {
  confirmsThreadsDeletion,
  threadsAccount,
  threadsEngagement,
  threadsFollowers,
  threadsGrantedScopes,
} from "../src/threads/responses";
import { failureThrownBy, malformedAnswer } from "./support";

const grant = (patch: object = {}) => ({
  data: { is_valid: true, user_id: "1", scopes: ["threads_basic", "threads_basic"], ...patch },
});
const profile = { id: "1", username: "creator" };

describe("threadsGrantedScopes", () => {
  it.each([
    ["a token for any account", undefined],
    ["a token for the expected account", "1"],
  ])("%s", (_example, account) => {
    expect(threadsGrantedScopes(grant(), account)).toEqual(["threads_basic"]);
  });

  it.each([
    ["an invalid token", grant({ is_valid: false })],
    ["no user", grant({ user_id: undefined })],
    ["another account", grant({ user_id: "2" })],
    ["scopes that are not a list", grant({ scopes: "threads_basic" })],
    ["a scope that is not a name", grant({ scopes: ["a b"] })],
    ["no data", {}],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => threadsGrantedScopes(body, "1"))).toEqual(malformedAnswer);
  });
});

describe("threadsAccount", () => {
  it("a profile with a name and a picture", () => {
    const full = { ...profile, name: "Name", threads_profile_picture_url: "https://cdn.test/a" };

    expect(threadsAccount(full)).toEqual({
      avatarUrl: "https://cdn.test/a",
      displayName: "Name",
      id: "1",
      username: "creator",
    });
  });

  it("a profile named by its username", () => {
    expect(threadsAccount(profile)).toEqual({
      displayName: "creator",
      id: "1",
      username: "creator",
    });
  });

  it.each([
    ["no ID", { username: "creator" }],
    ["no username", { id: "1" }],
    ["an insecure picture", { ...profile, threads_profile_picture_url: "http://cdn.test" }],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => threadsAccount(body))).toEqual(malformedAnswer);
  });
});

describe("threadsEngagement", () => {
  it("every metric, with reposts and quotes counted as shares", () => {
    const metrics = new Map([
      ["views", 101],
      ["likes", 12],
      ["replies", 3],
      ["reposts", 4],
      ["quotes", 5],
      ["shares", 6],
    ]);

    expect(threadsEngagement(metrics)).toEqual({ comments: 3, likes: 12, shares: 15, views: 101 });
  });

  it("no metric", () => {
    expect(threadsEngagement(new Map())).toEqual({ comments: 0, likes: 0, shares: 0, views: 0 });
  });
});

describe("threadsFollowers", () => {
  it("a follower count among other metrics", () => {
    const body = {
      data: [{ name: "views" }, { name: "followers_count", total_value: { value: 0 } }],
    };

    expect(threadsFollowers(body)).toEqual(0);
  });

  it.each([
    ["no list", {}],
    ["no follower metric", { data: [] }],
    ["a follower metric without a value", { data: [{ name: "followers_count" }] }],
  ])("refuses %s", (_example, body) => {
    expect(failureThrownBy(() => threadsFollowers(body))).toEqual(malformedAnswer);
  });
});

describe("confirmsThreadsDeletion", () => {
  it.each([
    ["a success", { success: true }, true],
    ["a success naming the post", { success: true, deleted_id: "p1" }, true],
    ["a success naming another post", { success: true, deleted_id: "p2" }, false],
    ["a refusal", { success: false }, false],
    ["no body", undefined, false],
  ])("%s", (_example, body, confirmed) => {
    expect(confirmsThreadsDeletion(body, "p1")).toEqual(confirmed);
  });
});
