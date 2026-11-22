import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";

export function git(...args) {
  const result = spawnSync("git", args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) {
    throw new Error(result.error?.message ?? result.stderr.trim() ?? "git failed");
  }
  return result.stdout.trim();
}

export function latestContractTag(ref = "HEAD", exclude) {
  return git("tag", "--merged", ref, "--list", "contract-v*", "--sort=-version:refname")
    .split("\n")
    .find((tag) => /^contract-v\d+\.\d+\.\d+$/.test(tag) && tag !== exclude);
}

export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function contractDigest(document) {
  const info = { ...document.info };
  delete info.version;
  return createHash("sha256")
    .update(canonical({ ...document, info }))
    .digest("hex");
}

export function breakingReviewToken(base, current) {
  return `contract-change:${createHash("sha256")
    .update(`${contractDigest(base)}:${contractDigest(current)}`)
    .digest("hex")}`;
}
