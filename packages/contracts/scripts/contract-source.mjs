import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

/** Runs a bounded Git query; errors are fatal rather than interpreted as an absent baseline. */
export function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim() ?? "git failed");
  }
  return result.stdout.trim();
}

/** Returns the newest reachable contract release tag, or undefined for the initial release. */
export function latestContractTag(ref = "HEAD") {
  return git("tag", "--merged", ref, "--list", "contract-v*", "--sort=-version:refname")
    .split("\n")
    .find((tag) => /^contract-v\d+\.\d+\.\d+$/.test(tag));
}

/** Serializes JSON-compatible contract values deterministically, ignoring YAML presentation. */
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Hashes the contract without its release version; used to bind review to the exact change. */
export function contractDigest(document) {
  const info = { ...document.info };
  delete info.version;
  return createHash("sha256")
    .update(canonical({ ...document, info }))
    .digest("hex");
}

/** Returns a review token for this exact semantic base/target pair, not a blanket waiver. */
export function breakingReviewToken(base, current) {
  return `contract-change:${createHash("sha256").update(`${contractDigest(base)}:${contractDigest(current)}`).digest("hex")}`;
}
