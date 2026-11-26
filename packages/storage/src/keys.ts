import { UNSAFE_PATH_SEGMENT_PATTERN } from "@meltiply/domain";

/**
 * Validates and normalizes an object key path segment.
 * Rejects empty strings, directory traversal segments ("." or ".."), slashes, and control characters.
 */
export function normalizeSegment(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || UNSAFE_PATH_SEGMENT_PATTERN.test(normalized)) {
    throw new TypeError(`${name} must be a non-empty path segment`);
  }
  return normalized;
}

/**
 * Constructs the upload-writable staging object key for an in-flight upload session.
 *
 * Uploads always land under the bucket-root `staging/` namespace so a bucket
 * lifecycle rule can expire abandoned staging bytes, while every publishable
 * object lives under the protected `<orgId>/<assetId>/` namespace.
 */
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

/**
 * Constructs a protected, publish-ready object key for an asset object.
 *
 * Ready keys keep `<orgId>/<assetId>/<name>` so object ownership stays
 * verifiable from the key alone; staging keys can never be signed for preview,
 * download, or Provider delivery.
 */
export function readyObjectKey(organizationId: string, assetId: string, name: string): string {
  return [
    normalizeSegment("organizationId", organizationId),
    normalizeSegment("assetId", assetId),
    normalizeSegment("name", name),
  ].join("/");
}
