import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const composeArgs = [
  "compose",
  "--env-file",
  ".env.selfhost",
  "-f",
  "compose.selfhost.yml",
  "--profile",
  "verification",
];
/** Runs only this deployment's services, preserving command failures and binary fixture bytes. */
function compose(...args) {
  return execFileSync("docker", [...composeArgs, ...args], { maxBuffer: 8 * 1024 * 1024 });
}
/** Invokes the container-private operational socket; no diagnostics endpoint is exposed publicly. */
function admin(...args) {
  return JSON.parse(
    compose("exec", "-T", "runtime", "node", "scripts/selfhost/admin.mjs", ...args).toString(),
  );
}
const origin = "http://localhost:8080";
let token;
/** Exercises the public API and reports bounded error bodies without logging credentials or verification URLs. */
async function api(path, body, expected = 200) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      origin,
      "content-type": "application/json",
      "idempotency-key": randomUUID(),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  assert.equal(
    response.status,
    expected,
    `${path}: ${response.status}: ${response.status === expected ? "" : (await response.text()).slice(0, 1500)}`,
  );
  return response.json();
}

await api("/api/v1/ready");
for (const url of [origin, "http://localhost:8081"]) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /<html/i);
  assert.doesNotMatch(html, /\/@vite\/client/);
}
for (const path of ["/cdn-cgi/local/explorer", "/cdn-cgi/handler/scheduled"]) {
  assert.equal((await fetch(`${origin}${path}`)).status, 404);
}
const operatorPath = `${origin}/operator/v1/selfhost-probe`;
assert.equal((await fetch(operatorPath)).status, 403);
const operator = admin("token", "operator@example.com");
assert.equal(
  (
    await fetch(operatorPath, {
      headers: { "Cf-Access-Jwt-Assertion": `${operator.token}invalid` },
    })
  ).status,
  403,
);
assert.equal(
  (await fetch(operatorPath, { headers: { "Cf-Access-Jwt-Assertion": operator.token } })).status,
  404,
);
console.log("Production frontends, readiness, private routing, and operator authentication passed");

const email = `selfhost-${randomUUID()}@example.com`;
const password = `Selfhost-${randomUUID()}!`;
await api("/api/auth/sign-up/email", {
  email,
  password,
  name: "Selfhost smoke",
  callbackURL: `${origin}/posts`,
});
let captured;
for (let attempt = 0; attempt < 60; attempt++) {
  const messages = await (await fetch("http://localhost:8025/api/v1/messages")).json();
  const message = messages.messages?.find((item) =>
    item.To?.some((recipient) => recipient.Address === email),
  );
  if (message) {
    captured = await (await fetch(`http://localhost:8025/api/v1/message/${message.ID}`)).json();
    break;
  }
  await delay(500);
}
assert.ok(captured, "Registration email must reach the actual SMTP endpoint");
const link = captured.Text.match(/https?:\/\/[^\s<>"']+\/api\/auth\/verify-email\?[^\s<>"']+/)?.[0];
assert.ok(link, "SMTP email must contain an actual verification link");
const verified = await fetch(link, { redirect: "manual" });
assert.ok([200, 302, 303].includes(verified.status), "Email verification must succeed");
const signIn = await fetch(`${origin}/api/auth/sign-in/email`, {
  method: "POST",
  headers: { origin, "content-type": "application/json" },
  body: JSON.stringify({ email, password }),
});
assert.equal(signIn.status, 200);
const cookie = signIn.headers
  .getSetCookie()
  .map((entry) => entry.split(";")[0])
  .join("; ");
const minted = await fetch(`${origin}/api/auth/token`, { headers: { cookie, origin } });
assert.equal(minted.status, 200);
token = (await minted.json()).token;
assert.equal(typeof token, "string");
const identity = await api("/api/v1/users/me");
assert.ok(identity, "Authenticated identity must resolve from PostgreSQL");
const profile = await api(
  "/api/v1/brand-profiles",
  { name: "Selfhost smoke", description: "Production image acceptance", color: "#1d4ed8" },
  201,
);
const png = compose(
  "exec",
  "-T",
  "processor",
  "ffmpeg",
  "-v",
  "error",
  "-f",
  "lavfi",
  "-i",
  "color=c=blue:s=640x640",
  "-frames:v",
  "1",
  "-f",
  "image2pipe",
  "-vcodec",
  "png",
  "pipe:1",
);
const upload = await api(
  "/api/v1/asset-upload-sessions",
  {
    asset_type: "image",
    brand_profile_id: profile.id,
    content_type: "image/png",
    file_size: png.byteLength,
    filename: "selfhost.png",
    title: "Selfhost processor smoke",
  },
  201,
);
const grant = upload.upload_session.single_upload;
assert.ok(grant, "Small images must receive a single-part upload capability");
const put = await fetch(grant.url, { method: grant.method, headers: grant.headers, body: png });
assert.ok(put.ok, `Signed R2 upload failed: ${put.status}`);
// Signature tampering must not permit an object overwrite.
const invalidGrant = new URL(grant.url);
invalidGrant.searchParams.set("X-Amz-Signature", "0".repeat(64));
assert.equal(
  (await fetch(invalidGrant, { method: grant.method, headers: grant.headers, body: png })).status,
  403,
);
await api(`/api/v1/asset-upload-sessions/${upload.upload_session.id}/complete`, {}, 202);
let asset;
for (let attempt = 0; attempt < 180; attempt++) {
  asset = await api(`/api/v1/assets/${upload.asset.id}`);
  if (asset.status === "ready") break;
  assert.notEqual(
    asset.status,
    "failed",
    `Media processing failed: ${JSON.stringify(asset.failure)}`,
  );
  await delay(1000);
}
assert.equal(
  asset.status,
  "ready",
  "Actual queue and native processor must finish the uploaded image",
);
assert.equal(asset.width, 640);
assert.equal(asset.height, 640);
console.log(
  "SMTP verification, production authentication, RLS database, signed storage, durable queue, and native media processing passed",
);

const probeId = randomUUID();
assert.equal(admin("probe-write", probeId).prepared, true);
// SIGKILL, not graceful shutdown: queued delays and workflow/OAuth state must
// survive an unexpected runtime loss. Restart the shared-network processor too.
compose("kill", "-s", "SIGKILL", "runtime", "processor");
compose("up", "-d", "--no-build", "--wait", "--wait-timeout", "120", "runtime", "processor");
assert.deepEqual(admin("probe-read", probeId), {
  storage: "recovered",
  oauth: "single-use",
  queue: "recovered",
  workflow: "complete",
});
await api("/api/v1/users/me");
assert.equal((await api(`/api/v1/assets/${upload.asset.id}`)).status, "ready");
console.log(
  "Crash recovery preserved sessions, PostgreSQL records, R2 objects, delayed queue messages, OAuth consumption, and workflow execution",
);
