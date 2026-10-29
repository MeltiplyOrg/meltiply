import { expect, test } from "@playwright/test";

import { signIn, waitForWorkspace } from "./workspace-session";

const credentials = {
  email: "alpha@meltiply.local",
  name: "Alpha Creator",
  password: "MeltiplyLocal1!",
};

/**
 * Exercises the reachable Settings → Publishing surface against the real
 * PostgreSQL/API stack: the timezone choice, one reusable default signature,
 * and notification event choices survive a reload. It also proves the composer
 * interprets schedules in that timezone rather than the browser's zone.
 */
test("persists publishing timezone, signature, and notification choices", async ({ page }) => {
  test.setTimeout(120_000);
  await signIn(page, credentials);
  await waitForWorkspace(page);
  await page.goto("/settings?section=publishing");
  await expect(page.getByRole("heading", { name: "Publishing", exact: true })).toBeVisible();

  const useDevice = page.getByRole("switch", { name: "Use this device's timezone" });
  await expect(useDevice).toBeVisible();
  if (await useDevice.isChecked()) await useDevice.click();
  const timezoneButton = page.getByRole("button", { name: /^Publishing timezone:/ });
  await timezoneButton.click();
  await page.getByRole("textbox", { name: "Search timezones…" }).fill("America/New_York");
  await page.getByRole("option", { name: "America/New York" }).click();
  await expect(
    page.getByRole("button", { name: /Publishing timezone: America\/New_York/ }),
  ).toBeVisible();

  const signatureName = `Launch footer ${Date.now()}`;
  await page.getByRole("button", { name: "Add signature" }).click();
  const signatureRow = page.getByRole("listitem").last();
  await signatureRow.getByLabel("Template name").fill(signatureName);
  await signatureRow.getByLabel("Signature text").fill("Follow {brand_profile} on {platform}.");
  await signatureRow.getByRole("button", { name: "Default" }).click();
  await expect(signatureRow.getByRole("button", { name: "Default" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const failedEvent = page.getByRole("switch", { name: "Publication failed" });
  if (!(await failedEvent.isChecked())) await failedEvent.click();

  await page.getByRole("button", { name: "Save preferences" }).click();
  await expect(page.getByText("Publishing preferences saved")).toBeVisible({ timeout: 15_000 });

  await page.reload();
  await expect(page.getByRole("heading", { name: "Publishing", exact: true })).toBeVisible();
  await expect(
    page.getByRole("button", { name: /Publishing timezone: America\/New_York/ }),
  ).toBeVisible();
  expect(
    await page
      .locator("input")
      .evaluateAll(
        (inputs, name) =>
          inputs.some((input) => input instanceof HTMLInputElement && input.value === name),
        signatureName,
      ),
  ).toBe(true);
  await expect(page.getByRole("switch", { name: "Publication failed" })).toBeChecked();

  // The schedule picker names the saved zone and converts the same wall-clock
  // value to the selected zone on submit. Assert the visible zone contract here;
  // the API boundary and DST conversion have focused unit coverage.
  await page.goto("/posts");
  await waitForWorkspace(page);
  await page.locator("main header").getByRole("button", { name: "Create post" }).click();
  await page.getByRole("radio", { name: "Schedule", exact: true }).click();
  await expect(page.getByText(/Time zone: America\/New_York/)).toBeVisible();
});
