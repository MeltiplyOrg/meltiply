// Improvement-reporting deployment wiring.
//
// These cases verify observable configuration behavior: how a released
// self-hosted image decides its reporting destination, and that missing
// configuration stays an honest "unavailable" instead of failing startup or
// pretending to work. The image defaults come from the Dockerfile the released
// runtime is built from, so a drift between build and runtime is caught here.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { reportingBindings } from "./reporting.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** Reads the ARG defaults the runtime image build declares. */
function imageDefaults() {
  const dockerfile = readFileSync(resolve(repositoryRoot, "scripts/selfhost/Dockerfile"), "utf8");
  const values = Object.fromEntries(
    [...dockerfile.matchAll(/^ARG (REPORTING_POSTHOG_[A-Z_]+)="([^"]*)"$/gm)].map((match) => [
      match[1],
      match[2],
    ]),
  );
  assert.ok("REPORTING_POSTHOG_PROJECT_TOKEN" in values, "the image declares its token argument");
  assert.ok("REPORTING_POSTHOG_HOST" in values, "the image declares its host argument");
  return {
    host: values.REPORTING_POSTHOG_HOST,
    project_token: values.REPORTING_POSTHOG_PROJECT_TOKEN,
  };
}

test("an unprovisioned image sets no reporting binding", () => {
  const defaults = imageDefaults();
  assert.equal(defaults.project_token, "");
  assert.equal(defaults.host, "");
  assert.deepEqual(reportingBindings(defaults, {}), {});
  assert.deepEqual(
    reportingBindings(defaults, {
      REPORTING_POSTHOG_HOST: "",
      REPORTING_POSTHOG_PROJECT_TOKEN: "",
    }),
    {},
    "empty operator values with no image default must leave reporting unavailable",
  );
});

test("operator values take precedence over the image destination", () => {
  const defaults = { host: "https://us.i.posthog.com", project_token: "phc_image000000000000000" };
  assert.deepEqual(reportingBindings(defaults, {}), {
    REPORTING_POSTHOG_HOST: defaults.host,
    REPORTING_POSTHOG_PROJECT_TOKEN: defaults.project_token,
  });
  assert.deepEqual(
    reportingBindings(defaults, {
      REPORTING_POSTHOG_HOST: "https://eu.i.posthog.com",
      REPORTING_POSTHOG_PROJECT_TOKEN: "phc_operator0000000000",
    }),
    {
      REPORTING_POSTHOG_HOST: "https://eu.i.posthog.com",
      REPORTING_POSTHOG_PROJECT_TOKEN: "phc_operator0000000000",
    },
  );
  // A blank operator value in an image that has a default means "use the
  // default", not "disable"; disabling is the override's job.
  assert.equal(
    reportingBindings(defaults, { REPORTING_POSTHOG_HOST: "  " }).REPORTING_POSTHOG_HOST,
    defaults.host,
  );
});
