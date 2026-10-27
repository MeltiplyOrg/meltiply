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
    const { promise, resolve } = Promise.withResolvers();
    setTimeout(resolve, 1000);
    await promise;
  }
}
const direct = await fetch(`${origin}/api/v1/users/me`);
assert.equal(direct.status, 503, "the Worker has no API when browser interception is absent");
assert.match(direct.headers.get("content-security-policy"), /connect-src 'self'/);

/** Opens the canonical developer dock and its preview-only tab, including after scenario reloads reset consent-free dock state. */
async function openPreviewControls(page) {
  const expand = page.getByRole("button", { name: "Expand DevBox", exact: true });
  await expect(page.getByRole("region", { name: "Meltiply DevBox", exact: true })).toBeVisible();
  if (await expand.isVisible()) await expand.click();
  await page.getByRole("tab", { name: "Preview", exact: true }).click();
  return page.getByRole("region", { name: "Preview controls", exact: true });
}
const browser = await chromium.launch();
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  const errors = [];
  const external = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("request", (request) => {
    if (!request.url().startsWith(origin) && !/^(data|blob):/.test(request.url()))
      external.push(request.url());
  });
  await page.goto(`${origin}/posts`);
  await expect(page.getByRole("heading", { name: "Posts", exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Reject optional", exact: true }).click();
  // Published rows can show frozen Channel copy instead of the current Post text; select a rendered caption without assuming API/display ordering.
  const candidates = await page.evaluate(
    async () => (await fetch("/api/v1/posts").then((response) => response.json())).posts,
  );
  const captionButtons = page
    .getByRole("table", { name: "Posts table", exact: true })
    .getByRole("row")
    .filter({ has: page.getByRole("checkbox", { name: "Select post", exact: true }) })
    .getByRole("button");
  await expect(captionButtons.first()).toBeVisible();
  const visibleCaptions = await captionButtons.allTextContents();
  const original = candidates.find((post) => visibleCaptions.includes(post.default_text));
  assert.ok(original, "the Posts table must render a record from the compiled seed");

  // Verify local file effects, not just canned upload responses: uploaded bytes must decode and remain attached after saving.
  const upload = await page.evaluate(
    async ({ bytes, profileId }) => {
      const created = await fetch("/api/v1/asset-upload-sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          asset_type: "image",
          brand_profile_id: profileId,
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
          brand_profile_id: profileId,
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
    {
      bytes: Array.from(await readFile("frontend/app/e2e/fixtures/composer-blue.png")),
      profileId: original.brand_profile_id,
    },
  );
  assert.deepEqual(upload, {
    initial: "created",
    completed: "completed",
    asset: "ready",
    image: [64, 64],
    caption: "Preview upload smoke",
    title: "Uploaded preview artwork",
  });
  const edited = await page.evaluate(
    async (post) =>
      fetch(`/api/v1/posts/${post.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          brand_profile_id: post.brand_profile_id,
          default_text: "Only this browser can see this edit",
        }),
      }).then((response) => response.json()),
    original,
  );
  assert.equal(edited.default_text, "Only this browser can see this edit");
  assert.equal(await page.evaluate(async () => (await fetch("/api/v1/no-fixture")).status), 501);
  await page.reload();
  await expect(
    page.getByRole("button", { name: original.default_text, exact: true }).first(),
  ).toBeVisible();
  const reset = await page.evaluate(
    async (id) => fetch(`/api/v1/posts/${id}`).then((response) => response.json()),
    original.id,
  );
  assert.equal(reset.default_text, original.default_text);

  // The route list comes from the real router; adding a literal frontend route automatically extends this browser smoke.
  let dialog = await openPreviewControls(page);
  await dialog.getByRole("combobox", { name: "Preview route", exact: true }).click();
  const routes = await page.getByRole("option").allTextContents();
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "Collapse DevBox", exact: true }).click();
  for (const route of routes) {
    dialog = await openPreviewControls(page);
    await dialog.getByRole("combobox", { name: "Preview route", exact: true }).click();
    await page.getByRole("option", { name: route, exact: true }).click();
    await dialog.getByRole("combobox", { name: "Preview scenario", exact: true }).click();
    await page
      .getByRole("option", {
        name: route === "/invitations/accept" ? "signed-out" : "populated",
        exact: true,
      })
      .click();
    const navigation = page.waitForEvent("domcontentloaded");
    await dialog.getByRole("button", { name: "Apply preview", exact: true }).click();
    await navigation;
    const headings = {
      "/": "Posts",
      "/posts": "Posts",
      "/analytics": "Analytics",
      "/channels": "Channels",
      "/queues": "Queues",
      "/settings": "Appearance",
    };
    if (headings[route])
      await expect(
        page.getByRole("heading", { name: headings[route], exact: true }).first(),
      ).toBeVisible();
    else if (route === "/sign-in")
      await expect(page.getByLabel("Email address", { exact: true })).toBeVisible();
    else if (route === "/channels/connect")
      await expect(page.getByRole("heading", { name: /^Connect / }).first()).toBeVisible();
    else if (route === "/invitations/accept")
      await expect(page.getByRole("heading", { name: /^Join / }).first()).toBeVisible();
    else await expect(page.getByRole("main").first()).toBeVisible();
    for (const dark of [false, true])
      for (const width of [1280, 390]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(
          (enabled) => document.documentElement.classList.toggle("dark", enabled),
          dark,
        );
        await page.screenshot({
          path: `artifacts/ui-preview/route-${route.replace(/\W+/g, "-") || "root"}-${dark ? "dark" : "light"}-${width}.png`,
          fullPage: true,
        });
      }
  }

  // Apply an empty state through the real controls, including a scoped operation. No query-cache or auth state may leak across the reload.
  await page.goto(`${origin}/posts`);
  dialog = await openPreviewControls(page);
  await dialog.getByRole("combobox", { name: "Preview scenario", exact: true }).click();
  await page.getByRole("option", { name: "empty", exact: true }).click();
  await dialog.getByRole("combobox", { name: "Preview operation", exact: true }).click();
  await page.getByRole("option", { name: "GET listPosts", exact: true }).click();
  await dialog.getByRole("button", { name: "Apply preview", exact: true }).click();
  await expect(
    page.getByText("No posts found matching the active filters.", { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Create post", exact: true }).first(),
  ).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-preview/scenario-empty.png", fullPage: true });

  for (const scenario of [
    "server-error",
    "permission-denied",
    "loading",
    "publication-failed",
    "channel-expired",
    "viewer",
    "editor",
    "success",
  ]) {
    const route = scenario === "channel-expired" ? "/channels" : "/posts";
    await page.goto(
      `${origin}${route}?previewScenario=${scenario}&previewOperation=${scenario === "channel-expired" ? "listPlatformAccounts" : "listPosts"}`,
    );
    await expect(page.getByRole("button", { name: "Expand DevBox", exact: true })).toBeVisible();
    if (scenario === "loading")
      await expect(page.getByRole("status").filter({ hasText: "Loading posts…" })).toBeVisible();
    else if (["server-error", "permission-denied"].includes(scenario))
      await expect(
        page.getByRole("main").getByRole("alert").filter({ hasText: "An error has occurred." }),
      ).toBeVisible({ timeout: 30_000 });
    else if (scenario === "viewer")
      await expect(page.getByRole("button", { name: "Create post", exact: true })).toHaveCount(0);
    else if (scenario === "publication-failed")
      await expect(page.getByRole("row").filter({ hasText: "Failed" }).last()).toBeVisible();
    else
      await expect(
        page.getByRole("heading", {
          name: route === "/channels" ? "Channels" : "Posts",
          exact: true,
        }),
      ).toBeVisible();
    await page.screenshot({
      path: `artifacts/ui-preview/scenario-${scenario}.png`,
      fullPage: true,
    });
  }
  await page.goto(`${origin}/sign-in?previewScenario=first-run`);
  await expect(
    page.getByRole("button", { name: "Create owner account", exact: true }),
  ).toBeVisible();
  await page.goto(`${origin}/sign-in?previewScenario=two-factor`);
  await page.getByLabel("Email address", { exact: true }).fill("preview@example.test");
  await page.getByLabel("Password", { exact: true }).fill("preview-only-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await expect(page.getByRole("button", { name: "Verify and sign in", exact: true })).toBeVisible();
  await page.screenshot({ path: "artifacts/ui-preview/scenario-two-factor.png", fullPage: true });

  await page.goto(
    `${origin}/posts?previewOperation=updatePost&previewStatus=422&previewScenario=validation-error`,
  );
  await expect(
    page.getByRole("button", { name: original.default_text, exact: true }).first(),
  ).toBeVisible();
  const rejected = await page.evaluate(
    async (post) =>
      (
        await fetch(`/api/v1/posts/${post.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            brand_profile_id: post.brand_profile_id,
            default_text: "Rejected by selected scenario",
          }),
        })
      ).status,
    original,
  );
  assert.equal(rejected, 422);
  assert.deepEqual(
    errors,
    [],
    "all preview routes/scenarios must render without browser exceptions",
  );
  assert.deepEqual(
    external,
    [],
    "no preview route may contact an external API, media host, or Provider",
  );
} finally {
  for (const context of browser.contexts())
    for (const page of context.pages())
      await page.screenshot({ path: "artifacts/ui-preview/final-state.png", fullPage: true });
  await browser.close();
}

/** Proves the mock runtime and canonical sample identities never ship in the production app. */
async function inspectProduction(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) await inspectProduction(path);
    else if (/\.(js|html)$/.test(entry.name))
      assert.doesNotMatch(
        await readFile(path, "utf8"),
        /alpha-admin@example\.test|alpha@meltiply\.local|MeltiplyLocal1!|mockServiceWorker\.js|preview_unhandled|Expand DevBox/,
      );
  }
}
await inspectProduction("frontend/app/dist/client");
console.log(
  "Contract-driven UI preview smoke passed: generated routes, outcome controls, auth/roles, local uploads/reset, isolation, and production exclusion.",
);
