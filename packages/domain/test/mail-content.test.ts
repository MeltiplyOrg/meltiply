import { describe, expect, it } from "vite-plus/test";

import {
  escapeMailHtml,
  isMailSenderAddress,
  isMailSenderName,
  mailSenderConfiguration,
} from "../src/mail-content.mjs";

const LONGEST_DOMAIN = `${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(61)}`;

describe("isMailSenderAddress", () => {
  it.each([
    ["a dot-atom address", "auth@meltiply.test", true],
    ["a dotted, tagged local part", "sender.name+tag@example.com", true],
    ["a single-label domain", "auth@meltiply", true],
    ["an address of 254 characters", `${"a".repeat(64)}@${LONGEST_DOMAIN}`, true],
    ["an address of 255 characters", `${"a".repeat(65)}@${LONGEST_DOMAIN}`, false],
    ["a header injection", "auth@meltiply.test\r\nBcc: x@y.test", false],
    ["a display-name form", "Meltiply <auth@meltiply.test>", false],
    ["a trailing comma", "auth@meltiply.test,", false],
    ["two at signs", "a@b@c.test", false],
    ["no at sign", "no-at-sign", false],
    ["a leading dot", ".sender@example.com", false],
    ["a dot before the at sign", "sender.@example.com", false],
    ["two dots in a row", "sender..name@example.com", false],
    ["a local part outside ASCII", "séndér@example.com", false],
    ["an empty string", "", false],
  ])("%s", (_example, value, expected) => {
    expect(isMailSenderAddress(value)).toEqual(expected);
  });

  it.each([
    ["a dotted domain, when one is required", "auth@meltiply.test", true],
    ["a single label, when a dot is required", "auth@meltiply", false],
    ["a dot only before the at sign, when one is required", "a.b@meltiply", false],
  ])("%s", (_example, value, expected) => {
    expect(isMailSenderAddress(value, true)).toEqual(expected);
  });
});

describe("isMailSenderName", () => {
  it.each([
    ["a plain name", "Meltiply", true],
    ["a name with spaces", "Meltiply Team", true],
    ["a name outside ASCII", "Méltiply 🚀", true],
    ["an empty name", "", true],
    ["a name of 200 characters", "n".repeat(200), true],
    ["a name of 201 characters", "n".repeat(201), false],
    ["a line break", "Meltiply\r\nInjected: yes", false],
    ["the last control character", "Meltiply\u001f", false],
    ["a delete character", "Meltiply\u007f", false],
    ["angle brackets", "Bad <name>", false],
    ["a double quote", 'a"b', false],
    ["a comma", "a,b", false],
    ["a colon", "a:b", false],
    ["a semicolon", "a;b", false],
    ["a backslash", "a\\b", false],
  ])("%s", (_example, value, expected) => {
    expect(isMailSenderName(value)).toEqual(expected);
  });
});

describe("escapeMailHtml", () => {
  it.each([
    ["markup and quotes", `<a href="x">&'</a>`, "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;"],
    ["an existing entity", "&amp;", "&amp;amp;"],
    ["an empty string", "", ""],
    ["text outside ASCII", "café 🚀", "café 🚀"],
  ])("%s", (_example, value, escaped) => {
    expect(escapeMailHtml(value)).toEqual(escaped);
  });
});

describe("mailSenderConfiguration", () => {
  it("a padded address and name", () => {
    const env = { MAIL_FROM_ADDRESS: "  auth@meltiply.test  ", MAIL_FROM_NAME: "  Meltiply  " };

    expect(mailSenderConfiguration(env)).toEqual({ email: "auth@meltiply.test", name: "Meltiply" });
  });

  it.each([
    ["an address without a name", { MAIL_FROM_ADDRESS: "auth@meltiply.test" }],
    ["a blank name", { MAIL_FROM_ADDRESS: "auth@meltiply.test", MAIL_FROM_NAME: "   " }],
  ])("%s", (_example, env) => {
    expect(mailSenderConfiguration(env)).toEqual({ email: "auth@meltiply.test" });
  });

  it.each([
    ["no address", {}],
    ["a blank address", { MAIL_FROM_ADDRESS: "   " }],
    ["an unsafe address", { MAIL_FROM_ADDRESS: "auth@meltiply.test\r\nBCC: v@example.com" }],
    [
      "a safe address with an unsafe name",
      { MAIL_FROM_ADDRESS: "auth@meltiply.test", MAIL_FROM_NAME: "Bad <name>" },
    ],
  ])("%s", (_example, env) => {
    expect(mailSenderConfiguration(env)).toEqual(undefined);
  });
});
