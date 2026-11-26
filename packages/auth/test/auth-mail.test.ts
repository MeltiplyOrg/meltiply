import { describe, expect, it } from "vite-plus/test";

import { passwordResetMail, verificationMail } from "../src/auth-mail";

const LINK = 'https://auth.example.test/t?a=1&b="<x>"';
const ESCAPED = "https://auth.example.test/t?a=1&amp;b=&quot;&lt;x&gt;&quot;";

describe("passwordResetMail", () => {
  it("a link with markup characters", () => {
    expect(passwordResetMail(LINK, "alpha@example.test")).toEqual({
      html: `<p>Reset your Meltiply password by opening <a href="${ESCAPED}">this link</a>. The link expires soon; if you did not request a reset, ignore this email.</p>`,
      subject: "Reset your Meltiply password",
      text: `Reset your Meltiply password: ${LINK}\n\nIf you did not request a reset, ignore this email.`,
      to: "alpha@example.test",
    });
  });
});

describe("verificationMail", () => {
  it("a link with markup characters", () => {
    expect(verificationMail(LINK, "alpha@example.test")).toEqual({
      html: `<p>Verify your Meltiply email address by opening <a href="${ESCAPED}">this link</a>.</p>`,
      subject: "Verify your Meltiply email",
      text: `Verify your Meltiply email address: ${LINK}`,
      to: "alpha@example.test",
    });
  });
});
