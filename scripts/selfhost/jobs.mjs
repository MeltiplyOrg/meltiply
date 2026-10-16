import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { z } from "zod";

const messageSchema = z.object({
  body: z.unknown(),
  contentType: z.enum(["json", "text", "bytes"]).default("json"),
  delaySeconds: z.number().int().min(0).max(43200).default(0),
});
const batchSchema = z.array(messageSchema).min(1).max(100);

/**
 * Single-process durable broker. WAL/FULL commits precede send acknowledgments;
 * leased jobs survive crashes and may be redelivered (never exactly once).
 * The database is infrastructure state, separate from application migrations.
 */
export class JobStore {
  constructor(path, queues, now = Date.now) {
    this.now = now;
    this.queues = queues;
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode=WAL;
      PRAGMA synchronous=FULL;
      PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, queue TEXT NOT NULL, body TEXT NOT NULL,
        content_type TEXT NOT NULL, created INTEGER NOT NULL,
        available INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS jobs_due ON jobs(queue, available);
      CREATE TABLE IF NOT EXISTS schedules (name TEXT PRIMARY KEY, slot INTEGER NOT NULL);
    `);
  }

  /** Commits a validated batch atomically; unknown queues and oversized messages fail before writes. */
  enqueue(queue, input) {
    if (!this.queues[queue]) throw new TypeError("Unknown queue");
    const messages = batchSchema.parse(input);
    const rows = messages.map((message) => {
      const body = JSON.stringify(message.body);
      if (body === undefined || Buffer.byteLength(body) > 128000) {
        throw new TypeError("Queue message exceeds 128000 bytes or is not JSON serializable");
      }
      return { ...message, body };
    });
    if (rows.reduce((sum, row) => sum + Buffer.byteLength(row.body), 0) > 288000) {
      throw new TypeError("Queue batch exceeds 288000 bytes");
    }
    const now = this.now();
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const insert = this.db.prepare(
        "INSERT INTO jobs (id, queue, body, content_type, created, available) VALUES (?, ?, ?, ?, ?, ?)",
      );
      for (const row of rows) {
        insert.run(
          randomUUID(),
          queue,
          row.body,
          row.contentType,
          now,
          now + row.delaySeconds * 1000,
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Records one current schedule slot and its job in the same transaction; downtime coalesces missed slots. */
  schedule(name, period, cron) {
    const slot = Math.floor(this.now() / period);
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.db.prepare("SELECT slot FROM schedules WHERE name = ?").get(name);
      if (!previous || previous.slot < slot) {
        this.db
          .prepare(
            "INSERT INTO schedules VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET slot = excluded.slot",
          )
          .run(name, slot);
        this.db
          .prepare(
            "INSERT INTO jobs (id, queue, body, content_type, created, available) VALUES (?, ?, ?, 'json', ?, ?)",
          )
          .run(
            randomUUID(),
            name,
            JSON.stringify({ cron, scheduledTime: slot * period }),
            this.now(),
            this.now(),
          );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Leases a bounded batch for fifteen minutes; expired leases are recoverable after process death. */
  claim(queue) {
    const config = this.queues[queue];
    if (!config || config.deadLetter) return [];
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const rows = this.db
        .prepare(
          "SELECT * FROM jobs WHERE queue = ? AND available <= ? ORDER BY available, created LIMIT ?",
        )
        .all(queue, this.now(), config.maxBatchSize ?? 1);
      const lease = this.db.prepare(
        "UPDATE jobs SET available = ?, attempts = attempts + 1 WHERE id = ?",
      );
      for (const row of rows) lease.run(this.now() + 900000, row.id);
      this.db.exec("COMMIT");
      return rows.map((row) => ({
        ...row,
        attempts: row.attempts + 1,
        body: JSON.parse(row.body),
      }));
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Applies explicit acknowledgments before retries; exhaustion moves rather than copies the job into its DLQ. */
  settle(queue, rows, result) {
    const config = this.queues[queue];
    const acks = new Set(result.explicitAcks ?? []);
    const retries = new Map(
      (result.retryMessages ?? []).map((retry) => [retry.msgId, retry.delaySeconds]),
    );
    this.db.exec("BEGIN IMMEDIATE");
    try {
      for (const row of rows) {
        const retry =
          !acks.has(row.id) &&
          (result.outcome !== "ok" || result.retryBatch?.retry || retries.has(row.id));
        if (!retry) {
          this.db.prepare("DELETE FROM jobs WHERE id = ?").run(row.id);
        } else if (row.attempts > config.maxRetries) {
          this.db
            .prepare("UPDATE jobs SET queue = ?, available = ? WHERE id = ?")
            .run(config.deadLetterQueue, this.now(), row.id);
        } else {
          const delay =
            retries.get(row.id) ??
            result.retryBatch?.delaySeconds ??
            config.retryDelay ??
            Math.min(3600, 2 ** row.attempts);
          this.db
            .prepare("UPDATE jobs SET available = ? WHERE id = ?")
            .run(this.now() + delay * 1000, row.id);
        }
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  /** Returns aggregate counts without exposing message bodies or credentials. */
  counts() {
    return this.db
      .prepare("SELECT queue, count(*) AS count FROM jobs GROUP BY queue ORDER BY queue")
      .all();
  }

  /** Supplies queue-handler metadata from committed backlog, including leased messages and delayed work. */
  metrics(queue) {
    const row = this.db
      .prepare(
        "SELECT count(*) AS count, coalesce(sum(length(CAST(body AS BLOB))), 0) AS bytes, min(created) AS oldest FROM jobs WHERE queue = ?",
      )
      .get(queue);
    return {
      backlogCount: row.count,
      backlogBytes: row.bytes,
      ...(row.oldest === null ? {} : { oldestMessageTimestamp: new Date(row.oldest) }),
    };
  }

  /** Requeues a bounded operator-selected DLQ batch, resetting its retry budget atomically. */
  replay(queue, limit = 100) {
    const config = this.queues[queue];
    if (!config?.deadLetter || !Number.isInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("Expected a dead-letter queue and a limit between 1 and 1000");
    }
    return this.db
      .prepare(
        "UPDATE jobs SET queue = ?, attempts = 0, available = ? WHERE id IN (SELECT id FROM jobs WHERE queue = ? ORDER BY created LIMIT ?)",
      )
      .run(config.source, this.now(), queue, limit).changes;
  }

  /** Checkpoints and closes state after the dispatch loop has stopped. */
  close() {
    this.db.close();
  }
}
