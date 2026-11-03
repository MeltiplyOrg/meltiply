import { describe, expect, it } from "vite-plus/test";

import {
  escapeMailHtml,
  isMailSenderAddress,
  isMailSenderName,
  mailSenderConfiguration,
} from "../src/mail-content.mjs";

describe("mail sender predicates", () => {
  it("accepts a normalized dot-atom address and rejects header syntax", () => {
    expect(isMailSenderAddress("auth@meltiply.test")).toBe(true);
    expect(isMailSenderAddress("auth@meltiply.test\r\nBcc: x@y.test")).toBe(false);
    expect(isMailSenderAddress("Meltiply <auth@meltiply.test>")).toBe(false);
    expect(isMailSenderAddress("auth@meltiply", true)).toBe(false);
    expect(isMailSenderAddress("auth@meltiply.test", true)).toBe(true);
  });

  it("rejects unsafe display-name characters", () => {
    expect(isMailSenderName("Meltiply")).toBe(true);
    expect(isMailSenderName("Meltiply\r\nInjected: yes")).toBe(false);
    expect(isMailSenderName("Bad <name>")).toBe(false);
  });
});

describe("escapeMailHtml", () => {
  it("escapes markup and existing entities once", () => {
    expect(escapeMailHtml(`<a href="x">&'</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;&amp;&#39;&lt;/a&gt;",
    );
    expect(escapeMailHtml("&amp;")).toBe("&amp;amp;");
  });
});

describe("mailSenderConfiguration", () => {
  it("returns a bare-address sender with trimmed optional display name", () => {
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "  auth@meltiply.test  ",
        MAIL_FROM_NAME: "  Meltiply  ",
      }),
    ).toEqual({ email: "auth@meltiply.test", name: "Meltiply" });
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "auth@meltiply.test" })).toEqual({
      email: "auth@meltiply.test",
    });
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "   ",
      }),
    ).toEqual({ email: "auth@meltiply.test" });
  });

  it("rejects display-name syntax and header injection in the address", () => {
    const injected = "auth@meltiply.test\r\nBCC: victim@example.com";
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: injected })).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "Meltiply <auth@meltiply.test>",
      }),
    ).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "auth@meltiply.test," })).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "a@b@c.test" })).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "no-at-sign" })).toBeUndefined();
    expect(mailSenderConfiguration({})).toBeUndefined();
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: "   " })).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: `${"a".repeat(250)}@x.test`,
      }),
    ).toBeUndefined();
  });

  // Dot-atom senders require nonempty atoms; valid dotted and tagged names
  // remain usable while malformed separators fail before mail dispatch.
  it("rejects empty local-part atoms without rejecting valid dotted senders", () => {
    for (const email of [
      ".sender@example.com",
      "sender.@example.com",
      "sender..name@example.com",
    ]) {
      expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: email })).toBeUndefined();
    }
    const email = "sender.name+tag@example.com";
    expect(mailSenderConfiguration({ MAIL_FROM_ADDRESS: email })).toEqual({
      email,
    });
  });

  it("fails closed on an unsafe display name instead of dropping it", () => {
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "Meltiply\r\nInjected: yes",
      }),
    ).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "Bad <name>",
      }),
    ).toBeUndefined();
    expect(
      mailSenderConfiguration({
        MAIL_FROM_ADDRESS: "auth@meltiply.test",
        MAIL_FROM_NAME: "n".repeat(201),
      }),
    ).toBeUndefined();
  });
});
