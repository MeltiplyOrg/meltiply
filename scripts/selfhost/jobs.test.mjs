import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobStore } from "./jobs.mjs";

/** Provides isolated disk state and a deterministic clock; every handle closes before cleanup. */
function fixture(t, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "meltiply-jobs-"));
  let time = 1000000;
  const policies = {
    publishing: { maxBatchSize: 5, maxRetries: 2, retryDelay: 30, deadLetterQueue: "publishing-dlq", ...options },
    "publishing-dlq": { deadLetter: true, source: "publishing" },
    hourly: { maxBatchSize: 1, maxRetries: 10, deadLetterQueue: "hourly-dlq" },
  };
  let store = new JobStore(join(directory, "jobs.sqlite"), policies, () => time);
  t.after(() => { store.close(); rmSync(directory, { recursive: true }); });
  return {
    get store() { return store; },
    advance(milliseconds) { time += milliseconds; },
    restart() { store.close(); store = new JobStore(join(directory, "jobs.sqlite"), policies, () => time); },
  };
}

test("acknowledged delayed sends survive restart and cannot be delivered early", (t) => {
  const f = fixture(t);
  f.store.enqueue("publishing", [{ body: { distribution: "one" }, delaySeconds: 60 }]);
  f.restart();
  assert.deepEqual(f.store.claim("publishing"), []);
  f.advance(60000);
  const rows = f.store.claim("publishing");
  assert.deepEqual(rows.map((row) => row.body), [{ distribution: "one" }]);
  f.store.settle("publishing", rows, { outcome: "ok" });
  f.restart();
  assert.deepEqual(f.store.counts(), []);
});

test("a crashed consumer's lease prevents early delivery but recovers with incremented attempts", (t) => {
  const f = fixture(t);
  f.store.enqueue("publishing", [{ body: "intent" }]);
  const [first] = f.store.claim("publishing");
  f.restart();
  assert.deepEqual(f.store.claim("publishing"), []);
  f.advance(900000);
  const [recovered] = f.store.claim("publishing");
  assert.equal(recovered.id, first.id);
  assert.equal(recovered.attempts, 2);
});

test("explicit acknowledgments survive batch failure while remaining messages retry at their own delay", (t) => {
  const f = fixture(t);
  f.store.enqueue("publishing", [{ body: "accepted" }, { body: "retry" }]);
  const rows = f.store.claim("publishing");
  f.store.settle("publishing", rows, { outcome: "exception", explicitAcks: [rows[0].id], retryMessages: [{ msgId: rows[1].id, delaySeconds: 7 }], retryBatch: { retry: true, delaySeconds: 20 } });
  f.restart(); f.advance(6999);
  assert.deepEqual(f.store.claim("publishing"), []);
  f.advance(1);
  assert.deepEqual(f.store.claim("publishing").map((row) => row.body), ["retry"]);
});

test("exhausted retries persist in the DLQ, never auto-consume, and bounded replay resets attempts", (t) => {
  const f = fixture(t, { maxRetries: 0 });
  f.store.enqueue("publishing", [{ body: "one" }, { body: "two" }]);
  f.store.settle("publishing", f.store.claim("publishing"), { outcome: "exception" });
  f.restart();
  assert.deepEqual(f.store.claim("publishing-dlq"), []);
  assert.deepEqual(f.store.counts(), [{ queue: "publishing-dlq", count: 2 }]);
  assert.equal(f.store.replay("publishing-dlq", 1), 1);
  const rows = f.store.claim("publishing");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].attempts, 1);
  assert.deepEqual(f.store.counts(), [{ queue: "publishing", count: 1 }, { queue: "publishing-dlq", count: 1 }]);
});

test("invalid or oversized batches are rejected atomically", (t) => {
  const f = fixture(t);
  assert.throws(() => f.store.enqueue("missing", [{ body: "lost" }]), /Unknown queue/);
  assert.throws(() => f.store.enqueue("publishing", [{ body: "first" }, { body: "x".repeat(128001) }]), /128000/);
  assert.throws(() => f.store.enqueue("publishing", [{ body: "first" }, { body: undefined }]), /serializable/);
  assert.deepEqual(f.store.counts(), []);
});

test("schedule slots persist without duplicates and downtime coalesces into a current sweep", (t) => {
  const f = fixture(t);
  f.store.schedule("hourly", 3600000, "0 * * * *");
  f.restart();
  f.store.schedule("hourly", 3600000, "0 * * * *");
  const first = f.store.claim("hourly");
  assert.equal(first.length, 1);
  f.store.settle("hourly", first, { outcome: "ok" });
  f.advance(4 * 3600000);
  f.store.schedule("hourly", 3600000, "0 * * * *");
  const next = f.store.claim("hourly");
  assert.deepEqual(next.map((row) => row.body), [{ cron: "0 * * * *", scheduledTime: 14400000 }]);
});
