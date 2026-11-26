import { describe, expect, it } from "vite-plus/test";

import {
  abbreviateRecordId,
  formatBytes,
  formatDuration,
  formatUsername,
  postDateFormatters,
  workspaceRoleLabel,
} from "./format";

describe("formatBytes", () => {
  it.each([
    ["zero bytes", 0, "0 B"],
    ["a negative size", -1, "-1 B"],
    ["the last size in bytes", 1023, "1023 B"],
    ["exactly one kilobyte", 1024, "1.0 KB"],
    ["the last size in kilobytes", 1024 ** 2 - 1, "1024.0 KB"],
    ["exactly one megabyte", 1024 ** 2, "1.0 MB"],
    ["the last size in megabytes", 1024 ** 3 - 1, "1024.0 MB"],
    ["exactly one gigabyte", 1024 ** 3, "1.00 GB"],
    ["gigabytes with a fraction", 2.5 * 1024 ** 3, "2.50 GB"],
  ])("%s", (_example, bytes, text) => {
    expect(formatBytes(bytes)).toEqual(text);
  });
});

describe("formatDuration", () => {
  it.each([
    ["zero seconds", 0, "0:00"],
    ["one second", 1, "0:01"],
    ["the last second below a minute", 59, "0:59"],
    ["exactly one minute", 60, "1:00"],
    ["a minute and a few seconds", 65, "1:05"],
    ["a fraction of a second", 59.9, "0:59"],
    ["an hour, kept in minutes", 3600, "60:00"],
  ])("%s", (_example, seconds, text) => {
    expect(formatDuration(seconds)).toEqual(text);
  });

  it("a negative duration (today: -1:-1)", () => {
    expect(formatDuration(-1)).toEqual("-1:-1");
  });

  it.skip("a negative duration (bug: should read -0:01)", () => {
    expect(formatDuration(-1)).toEqual("-0:01");
  });
});

describe("abbreviateRecordId", () => {
  it.each([
    ["a UUID", "3f7c1a92-5b4e-4d21-9a77-0c8f2e1b6d40", "1b6d40"],
    ["an ID that differs only at its end", "48000000-0000-4000-8000-000000000002", "000002"],
    ["six characters", "abc123", "abc123"],
    ["seven characters", "abc1234", "bc1234"],
    ["an empty ID", "", ""],
  ])("%s", (_example, id, short) => {
    expect(abbreviateRecordId(id)).toEqual(short);
  });
});

describe("formatUsername", () => {
  it.each([
    ["a bare name", "melti", "@melti"],
    ["a name that has its at sign", "@melti", "@melti"],
    ["a padded name", "  melti  ", "@melti"],
    ["a name outside ASCII", "bánh", "@bánh"],
    ["a blank name", "   ", null],
    ["no name", undefined, null],
    ["a null name", null, null],
  ])("%s", (_example, raw, username) => {
    expect(formatUsername(raw)).toEqual(username);
  });
});

describe("workspaceRoleLabel", () => {
  const translate = (message: string) => `[${message}]`;

  it.each([
    ["admin", "[Admin]"],
    ["editor", "[Editor]"],
    ["viewer", "[Viewer]"],
  ] as const)("the %s role", (role, label) => {
    expect(workspaceRoleLabel(translate, role)).toEqual(label);
  });
});

describe("postDateFormatters", () => {
  const instant = new Date("2026-01-01T04:30:00.000Z");

  it.each([
    ["a zone behind UTC", "America/New_York", "Dec 31", "11:30 PM"],
    ["a zone ahead of UTC", "Asia/Tokyo", "Jan 1", "01:30 PM"],
  ])("%s", (_example, timeZone, day, time) => {
    const formatters = postDateFormatters(timeZone);

    expect(formatters.day.format(instant)).toEqual(day);
    expect(formatters.time.format(instant)).toEqual(time);
  });

  it("the same zone twice", () => {
    const first = postDateFormatters("Asia/Kolkata");

    expect(postDateFormatters("Asia/Kolkata")).toBe(first);
  });

  it("a zone followed by three others stays cached", () => {
    const first = postDateFormatters("Europe/Paris");
    for (const zone of ["Europe/Rome", "Europe/Oslo", "Europe/Riga"]) postDateFormatters(zone);

    expect(postDateFormatters("Europe/Paris")).toBe(first);
  });

  it("a zone followed by four others is rebuilt", () => {
    const first = postDateFormatters("Africa/Cairo");
    for (const zone of ["Africa/Lagos", "Africa/Accra", "Africa/Tunis", "Africa/Algiers"]) {
      postDateFormatters(zone);
    }

    expect(postDateFormatters("Africa/Cairo")).not.toBe(first);
  });
});
