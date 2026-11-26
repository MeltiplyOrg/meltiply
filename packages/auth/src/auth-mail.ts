import { escapeMailHtml } from "@meltiply/domain/mail-content";

export function passwordResetMail(link: string, to: string) {
  return {
    html: `<p>Reset your Meltiply password by opening <a href="${escapeMailHtml(link)}">this link</a>. The link expires soon; if you did not request a reset, ignore this email.</p>`,
    subject: "Reset your Meltiply password",
    text: `Reset your Meltiply password: ${link}\n\nIf you did not request a reset, ignore this email.`,
    to,
  };
}

export function verificationMail(link: string, to: string) {
  return {
    html: `<p>Verify your Meltiply email address by opening <a href="${escapeMailHtml(link)}">this link</a>.</p>`,
    subject: "Verify your Meltiply email",
    text: `Verify your Meltiply email address: ${link}`,
    to,
  };
}
