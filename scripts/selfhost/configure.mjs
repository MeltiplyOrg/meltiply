import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";

const ci = process.argv.includes("--ci");
const path = process.env.SELFHOST_ENV_FILE || ".env.selfhost";
const platform =
  process.env.SELFHOST_PLATFORM ||
  (process.arch === "arm64" ? "linux/arm64" : process.arch === "x64" ? "linux/amd64" : "");
if (!["linux/amd64", "linux/arm64"].includes(platform))
  throw new TypeError("SELFHOST_PLATFORM must be linux/amd64 or linux/arm64");
const values = {
  SELFHOST_ORIGIN: "http://localhost:8080",
  SELFHOST_BIND_ADDRESS: "127.0.0.1",
  SELFHOST_IMAGE_PREFIX: "ghcr.io/meltiplyorg/meltiply",
  SELFHOST_IMAGE_TAG: "latest",
  SELFHOST_PLATFORM: platform,
  SELFHOST_DB_PASSWORD: randomBytes(32).toString("hex"),
  SELFHOST_DB_SYSTEM_PASSWORD: randomBytes(32).toString("hex"),
  SELFHOST_DB_AUTHENTICATED_PASSWORD: randomBytes(32).toString("hex"),
  BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
  AUTH_SETUP_SECRET: randomBytes(32).toString("hex"),
  TOKEN_ENCRYPTION_KEY: randomBytes(32).toString("base64url"),
  SELFHOST_OPERATOR_SECRET: randomBytes(32).toString("hex"),
  PROCESSOR_JOB_TOKEN: randomBytes(32).toString("hex"),
  RECURRING_COMMENTS_ENABLED: "false",
  R2_ACCESS_KEY_ID: randomBytes(16).toString("hex"),
  R2_SECRET_ACCESS_KEY: randomBytes(32).toString("hex"),
  MAIL_FROM_ADDRESS: ci ? "no-reply@example.com" : "",
  SELFHOST_SMTP_URL: ci ? "smtp://smtp-test:1025" : "",
};
await writeFile(
  path,
  Object.entries(values)
    .map(([name, value]) => `${name}=${value}\n`)
    .join(""),
  { mode: 0o600, flag: "wx" },
);
console.log(
  `Created ${path} with private random credentials. Email is optional: set MAIL_FROM_ADDRESS and SELFHOST_SMTP_URL to require verification, or leave them empty to allow unverified owner setup.`,
);
