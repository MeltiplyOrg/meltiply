import assert from "node:assert/strict";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { chromium, expect } from "@playwright/test";

const origin = "http://127.0.0.1:4173";
await mkdir("artifacts/ui-preview", { recursive: true });
for (let attempt = 0; ; attempt++) {
  try {
    await fetch(origin);
    break;
  } catch (error) {
    if (attempt >= 60) throw error;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
}
const direct = await fetch(`${origin}/api/v1/users/me`);
assert.equal(
  direct.status,
  503,
  "the deployed Worker must reject API access without browser fixtures",
);
assert.match(direct.headers.get("content-security-policy"), /connect-src 'self'/);
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error") console.error(message.text());
  });
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !/^(data|blob):/.test(request.url()))
      external.push(request.url());
  });
  await page.goto(`${origin}/posts`);
  await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "UI preview" })).toBeVisible();
  await page.getByRole("button", { name: "Reject optional", exact: true }).click();
  await expect(
    page.getByRole("button", { name: /^A little progress, every day/ }).first(),
  ).toBeVisible();
  const upload = await page.evaluate(
    async (bytes) => {
      const created = await fetch("/api/v1/asset-upload-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset_type: "image",
          brand_profile_id: "00000000-0000-4000-8000-000000000111",
          filename: "sample.png",
          content_type: "image/png",
          file_size: bytes.length,
          title: "Uploaded preview artwork",
        }),
      }).then((response) => response.json());
      await fetch(created.upload_session.single_upload.url, {
        method: "PUT",
        headers: { "Content-Type": "image/png" },
        body: new Uint8Array(bytes),
      });
      const completed = await fetch(
        `/api/v1/asset-upload-sessions/${created.upload_session.id}/complete`,
        { method: "POST" },
      ).then((response) => response.json());
      const preview = await fetch(`/api/v1/assets/${created.asset.id}/preview-url`).then(
        (response) => response.json(),
      );
      const image = new Image();
      image.src = preview.url;
      await image.decode();
      const post = await fetch("/api/v1/posts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_profile_id: "00000000-0000-4000-8000-000000000111",
          default_text: "Preview upload smoke",
          attachment_ids: [created.asset.id],
        }),
      }).then((response) => response.json());
      return {
        initial: created.upload_session.status,
        completed: completed.upload_session.status,
        asset: post.attachments[0].asset.status,
        image: [image.naturalWidth, image.naturalHeight],
        caption: post.default_text,
        title: post.attachments[0].asset.title,
      };
    },
    Array.from(await readFile("frontend/app/e2e/fixtures/composer-blue.png")),
  );
  assert.deepEqual(upload, {
    initial: "created",
    completed: "completed",
    asset: "ready",
    image: [64, 64],
    caption: "Preview upload smoke",
    title: "Uploaded preview artwork",
  });
  const edited = await page.evaluate(async () => {
    const response = await fetch("/api/v1/posts/00000000-0000-4000-8000-000000000701", {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        brand_profile_id: "00000000-0000-4000-8000-000000000111",
        default_text: "Only this browser can see this edit",
      }),
    });
    return response.json();
  });
  assert.equal(edited.default_text, "Only this browser can see this edit");
  const unknown = await page.evaluate(async () => (await fetch("/api/v1/no-fixture")).status);
  assert.equal(unknown, 422);
  await page.reload();
  await expect(
    page.getByRole("button", { name: /^A little progress, every day/ }).first(),
  ).toBeVisible();
  const reset = await page.evaluate(async () =>
    (await fetch("/api/v1/posts/00000000-0000-4000-8000-000000000701")).json(),
  );
  assert.match(reset.default_text, /synthetic sample content/);
  for (const [route, heading] of [
    ["posts", "Posts"],
    ["analytics", "Analytics"],
    ["channels", "Channels"],
    ["queues", "Queues"],
  ]) {
    await page.goto(`${origin}/${route}`);
    await expect(page.getByRole("heading", { name: heading, exact: true }).first()).toBeVisible();
    for (const dark of [false, true])
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          (enabled) => document.documentElement.classList.toggle("dark", enabled),
          dark,
        );
        await page.screenshot({
          path: `artifacts/ui-preview/${route}-${dark ? "dark" : "light"}-${width}.png`,
          fullPage: true,
        });
      }
  }
  assert.deepEqual(errors, [], "preview routes must not throw browser errors");
  assert.deepEqual(external, [], "preview must make no external requests");
} finally {
  for (const context of browser.contexts())
    for (const page of context.pages()) {
      await page.screenshot({ path: "artifacts/ui-preview/final-state.png", fullPage: true });
    }
  await browser.close();
}

/** Inspects emitted production assets recursively to prove sample identity and MSW bootstrap do not ship. */
async function inspectProduction(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await inspectProduction(path);
    else if (/\.(js|html)$/.test(entry.name)) {
      const source = await readFile(path, "utf8");
      assert.doesNotMatch(source, /preview@example\.test|mockServiceWorker\.js/);
    }
  }
}
await inspectProduction("frontend/app/dist/client");
console.log(
  "UI preview smoke passed: isolated Worker, fake session, mutable/reset data, nested routes, palettes/viewports, production exclusion.",
);
