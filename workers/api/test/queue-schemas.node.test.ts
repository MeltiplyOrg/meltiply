import { describe, expect, it } from "vite-plus/test";

import { queueConfigurationSchema, queuePatchSchema, queueScopeSchema } from "../src/validation";

const PROFILE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const slot = { weekday: 1, time: "09:00" };
const valid = { brand_profile_id: PROFILE, name: "Weekly", slots: [slot], timezone: "UTC" };
const week = Array.from({ length: 168 }, (_, index) => ({
  weekday: Math.floor(index / 24),
  time: `${String(index % 24).padStart(2, "0")}:00`,
}));

const rejectedFields = (input: unknown) =>
  queueConfigurationSchema.safeParse(input).error?.issues.map((issue) => issue.path.join("."));

describe("queueConfigurationSchema", () => {
  it("a configuration with a padded name", () => {
    expect(queueConfigurationSchema.parse({ ...valid, name: "  Weekly  " })).toEqual(valid);
  });

  it.each([
    ["a name of 100 characters", { name: "n".repeat(100) }],
    ["a slot for every hour of the week", { slots: week }],
    [
      "the first and last minute of the week",
      {
        slots: [
          { weekday: 0, time: "00:00" },
          { weekday: 6, time: "23:59" },
        ],
      },
    ],
  ])("%s", (_example, patch) => {
    expect(queueConfigurationSchema.parse({ ...valid, ...patch })).toEqual({ ...valid, ...patch });
  });

  it.each([
    ["a blank name", { name: "   " }, ["name"]],
    ["a name of 101 characters", { name: "n".repeat(101) }, ["name"]],
    ["an unknown timezone", { timezone: "Not/A_Zone" }, ["timezone"]],
    ["a UTC offset instead of a zone", { timezone: "+01:00" }, ["timezone"]],
    ["no slot", { slots: [] }, ["slots"]],
    ["169 slots", { slots: [...week, { weekday: 0, time: "00:30" }] }, ["slots"]],
    ["weekday seven", { slots: [{ weekday: 7, time: "12:00" }] }, ["slots.0.weekday"]],
    ["a negative weekday", { slots: [{ weekday: -1, time: "12:00" }] }, ["slots.0.weekday"]],
    ["hour twenty-four", { slots: [{ weekday: 1, time: "24:00" }] }, ["slots.0.time"]],
    ["a one-digit hour", { slots: [{ weekday: 1, time: "9:00" }] }, ["slots.0.time"]],
    ["the same slot twice", { slots: [slot, slot] }, ["slots"]],
    ["an id that is not a UUID", { brand_profile_id: "profile" }, ["brand_profile_id"]],
    ["an unknown field", { color: "#fff" }, [""]],
  ])("%s", (_example, patch, fields) => {
    expect(rejectedFields({ ...valid, ...patch })).toEqual(fields);
  });
});

describe("queuePatchSchema", () => {
  it("only the Brand Profile", () => {
    expect(queuePatchSchema.parse({ brand_profile_id: PROFILE })).toEqual({
      brand_profile_id: PROFILE,
    });
  });
});

describe("queueScopeSchema", () => {
  it("a Brand Profile", () => {
    expect(queueScopeSchema.parse({ brand_profile_id: PROFILE })).toEqual({
      brand_profile_id: PROFILE,
    });
  });

  it("another field", () => {
    expect(queueScopeSchema.safeParse({ brand_profile_id: PROFILE, name: "x" }).success).toEqual(
      false,
    );
  });
});
