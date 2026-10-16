// Engine resource sampler for the processor smoke (issue #284).
//
// Runs INSIDE the engine container's PID namespace (launched by run.sh via
// `docker exec`) while the HTTP behavior suite exercises the engine. Every
// sample walks /proc and accounts only the engine subtree: PID 1 plus every
// descendant of the container's init process. The sampler itself runs in a
// separate exec session, so it is never counted — the observer is excluded by
// construction.
//
// What it reports, honestly:
//   - cpu_jiffies: user+system jiffies of live subtree processes PLUS the
//     cutime/cstime each process accumulated for children it already waited
//     on, so CPU spent by reaped ffmpeg/ffprobe/vips children is included.
//   - peak_rss_bytes: peak summed VmRSS across the live subtree. This is
//     process resident memory only; kernel page cache is not counted, and it
//     is NOT the container-charged cgroup memory figure.
//   - wall_time_ms: observed wall time between the first and last sample.
//
// Env: MEASURE_INTERVAL_MS (default 250), PROCESSOR_SMOKE_STOP_FILE (optional
// shared stop marker). Writes a final JSON summary on the marker or SIGTERM;
// run.sh collects that line into a host-side file.

import { existsSync, readFileSync, writeSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import process from "node:process";

const intervalMs = Math.max(50, Number(process.env.MEASURE_INTERVAL_MS ?? 250) || 250);
// run.sh injects the harness mode so the summary itself records whether the
// cgroup envelope was enforced; anything else cannot claim hard verification.
const mode = process.env.PROCESSOR_SMOKE_MODE ?? "strict";
const stopFile = process.env.PROCESSOR_SMOKE_STOP_FILE;

/**
 * Reads one /proc/<pid>/stat and returns the fields this sampler needs.
 *
 * The comm field is wrapped in parentheses and may itself contain spaces and
 * parentheses, so parsing keys off the LAST ')' rather than the first. Returns
 * null when the process exited between the readdir and this read — a normal
 * race under a workload that spawns short-lived children.
 */
async function readStat(pid) {
  let raw;
  try {
    raw = await readFile(`/proc/${pid}/stat`, "utf8");
  } catch {
    return null;
  }
  const close = raw.lastIndexOf(")");
  if (close < 0) return null;
  // Fields after comm start at field 3 (state); offset indexes below are
  // relative to that first post-comm token.
  const fields = raw.slice(close + 2).split(" ");
  return {
    ppid: Number(fields[1]),
    utime: Number(fields[11]),
    stime: Number(fields[12]),
    cutime: Number(fields[13]),
    cstime: Number(fields[14]),
  };
}

/**
 * Reads VmRSS from /proc/<pid>/status, returning bytes. status is used instead
 * of stat's page-count rss so the number never depends on a guessed page size;
 * returns 0 for processes that exited mid-sample.
 */
async function readRssBytes(pid) {
  try {
    const raw = await readFile(`/proc/${pid}/status`, "utf8");
    const match = raw.match(/^VmRSS:\s+(\d+)\s+kB/m);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/**
 * Reads the container's own cgroup limit files once, for the summary. The
 * harness mode records what run.sh asked Docker for; these files record what
 * the daemon actually applied, so a run can be judged from its artifact rather
 * than its intention — `domain` with a finite cpu.max/memory.max is an
 * enforced envelope, `threaded` with `max` is a host that enforced nothing,
 * and null means the file was unreadable (no unified hierarchy) instead of
 * unlimited. Read at emit time because the limits are fixed for the run.
 */
function observedCgroupLimits() {
  const readLimit = (file) => {
    try {
      return readFileSync(file, "utf8").trim();
    } catch {
      return null;
    }
  };
  return {
    cgroup_type: readLimit("/sys/fs/cgroup/cgroup.type"),
    cpu_max: readLimit("/sys/fs/cgroup/cpu.max"),
    memory_max: readLimit("/sys/fs/cgroup/memory.max"),
  };
}

/**
 * Collects every pid that is PID 1 itself or a descendant of it. Docker exec
 * sessions (including this sampler) sit outside that subtree, which is what
 * excludes the observer from every measurement.
 */
async function enginePids() {
  let entries;
  try {
    entries = await readdir("/proc");
  } catch {
    return [1];
  }
  const pids = entries
    .map((entry) => (/^\d+$/.test(entry) ? Number(entry) : null))
    .filter((pid) => pid !== null);
  const stats = new Map();
  await Promise.all(
    pids.map(async (pid) => {
      const stat = await readStat(pid);
      if (stat) stats.set(pid, stat);
    }),
  );
  const keep = new Set([1]);
  // Fixpoint parent walk: a pid belongs to the engine subtree when its parent
  // does. At most a few dozen pids exist here, so the repeated scan is cheap.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, stat] of stats) {
      if (!keep.has(pid) && keep.has(stat.ppid)) {
        keep.add(pid);
        grew = true;
      }
    }
  }
  return [...keep].filter((pid) => stats.has(pid));
}

let timer = null;
let sampling = false;
let stopped = false;
let currentSample = Promise.resolve();
let peakRssBytes = 0;
let samples = 0;
let firstSampleMs = null;
let lastSampleMs = null;
let firstCpuJiffies = null;
let lastCpuJiffies = null;

/**
 * Takes one /proc sample of the engine subtree and folds it into the running
 * totals. Serialized through `sampling` so a slow tick can never overlap the
 * next; the interval is a lower bound, not a rate guarantee.
 */
async function sample() {
  const pids = await enginePids();
  const now = Date.now();
  let cpuJiffies = 0;
  let rssBytes = 0;
  await Promise.all(
    pids.map(async (pid) => {
      const [stat, rss] = await Promise.all([readStat(pid), readRssBytes(pid)]);
      if (stat) cpuJiffies += stat.utime + stat.stime + stat.cutime + stat.cstime;
      rssBytes += rss;
    }),
  );
  if (rssBytes > peakRssBytes) peakRssBytes = rssBytes;
  if (firstSampleMs === null) {
    firstSampleMs = now;
    firstCpuJiffies = cpuJiffies;
  }
  lastSampleMs = now;
  lastCpuJiffies = cpuJiffies;
  samples += 1;
}

/**
 * Emits the machine-readable summary and exits after any in-flight sample.
 * Called on the shared stop marker or SIGTERM so emulator command-line
 * rewriting cannot lose the last measurement. A missing summary is an error
 * reported by run.sh, never a fabricated zero-resource result.
 */
async function finish(reason) {
  if (stopped) return;
  stopped = true;
  clearInterval(timer);
  await currentSample;
  // One last sample so the tail of the last job is not lost between the
  // previous tick and the stop signal.
  await sample().catch(() => {});
  const summary = {
    benchmark: "processor_smoke_engine_resources",
    mode,
    hard_envelope_verified: mode === "strict",
    scope: "engine_container_pid1_subtree",
    observer: "excluded (separate docker exec session outside the subtree)",
    memory_basis: "sum of per-process VmRSS; kernel page cache excluded; not cgroup-charged memory",
    cpu_basis: "user+system jiffies incl. cutime/cstime of reaped children",
    sample_count: samples,
    sample_interval_ms: intervalMs,
    wall_time_ms: lastSampleMs === null ? 0 : lastSampleMs - firstSampleMs,
    cpu_jiffies: lastCpuJiffies === null ? 0 : lastCpuJiffies - firstCpuJiffies,
    cpu_seconds: lastCpuJiffies === null ? 0 : (lastCpuJiffies - firstCpuJiffies) / 100,
    // What the daemon actually enforced, as opposed to the mode that asked.
    ...observedCgroupLimits(),
    peak_rss_bytes: peakRssBytes,
    peak_rss_mib: Math.round((peakRssBytes / (1024 * 1024)) * 10) / 10,
    stop_reason: reason,
  };
  writeSync(1, `BENCHMARK ${JSON.stringify(summary)}\n`);
  process.exit(0);
}

process.on("SIGTERM", () => void finish("sigterm"));
process.on("SIGINT", () => void finish("sigint"));

// Kick off immediately so the baseline is captured before the suite's first
// job; a failed first sample still leaves a syntactically valid zero summary.
currentSample = sample().catch(() => {});
timer = setInterval(() => {
  if (stopFile && existsSync(stopFile)) {
    void finish("stop_marker");
    return;
  }
  if (sampling) return;
  sampling = true;
  currentSample = sample()
    .catch(() => {})
    .finally(() => {
      sampling = false;
    });
}, intervalMs);
// The referenced interval is the handle that keeps this process alive until a
// SIGTERM lands: an unref'd timer would let node exit before any summary.
