import { UNSAFE_PATH_SEGMENT_PATTERN } from "@meltiply/domain";

export function normalizeSegment(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || UNSAFE_PATH_SEGMENT_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a non-empty path segment`);
  }
  return normalized;
}

/** Upload-writable `staging/` key; bucket lifecycle rules expire abandoned staging objects. */
export function stagingObjectKey(
  organizationId: string,
  assetId: string,
  sessionId: string,
  filename: string,
): string {
  return [
    "staging",
    normalizeSegment("organizationId", organizationId),
    normalizeSegment("assetId", assetId),
    normalizeSegment("sessionId", sessionId),
    normalizeSegment("filename", filename),
  ].join("/");
}

/** Protected `<orgId>/<assetId>/<name>` key for verified, publishable objects. */
export function readyObjectKey(organizationId: string, assetId: string, name: string): string {
  return [
    normalizeSegment("organizationId", organizationId),
    normalizeSegment("assetId", assetId),
    normalizeSegment("name", name),
  ].join("/");
}
