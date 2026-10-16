import assert from "node:assert/strict";
import { test } from "node:test";

import { readBoundedJsonResponse, readBoundedResponseBody } from "./release-http.mjs";

test("bounded HTTP reads stream before allocating and parse exact JSON", async () => {
  assert.equal(await readBoundedResponseBody(new Response("safe"), 4, "test response"), "safe");
  assert.deepEqual(await readBoundedJsonResponse(new Response('{"ok":true}'), 32), { ok: true });
  await assert.rejects(
    readBoundedResponseBody(new Response("12345"), 4, "test response"),
    /test response is too large/,
  );
  await assert.rejects(readBoundedJsonResponse(new Response("not json"), 32), /valid JSON/);
  let cancelled = false;
  const oversized = {
    body: { cancel: async () => (cancelled = true) },
    headers: { get: () => "100" },
  };
  await assert.rejects(readBoundedResponseBody(oversized, 4, "test response"), /too large/);
  assert.equal(cancelled, true);
});
