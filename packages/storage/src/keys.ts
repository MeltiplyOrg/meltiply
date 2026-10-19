const invalidSegment = /(^\.{1,2}$)|[\\/\u0000-\u001f\u007f]/;

/**
 * Validates and normalizes an object key path segment.
 * Rejects empty strings, directory traversal segments ("." or ".."), slashes, and control characters.
 *
 * @param name - Segment parameter name for error reporting.
 * @param value - Raw segment string value.
 * @returns Trimmed, valid path segment string.
 * @throws {TypeError} If segment is invalid, empty, or contains prohibited characters.
 */
export function normalizeSegment(name: string, value: string): string {
  const normalized = value.trim();
  if (!normalized || invalidSegment.test(normalized)) {
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
 *
 * @param organizationId - Tenant organization UUID segment.
 * @param assetId - Asset UUID segment.
 * @param sessionId - Upload session UUID segment, keeping concurrent retries of one asset distinct.
 * @param filename - Sanitized single-segment filename.
 * @returns `staging/<orgId>/<assetId>/<sessionId>/<filename>`.
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
 *
 * @param organizationId - Tenant organization UUID segment.
 * @param assetId - Asset UUID segment.
 * @param name - Object name segment (`original`, `rendition-optimized`, `thumbnail`, …).
 * @returns `<orgId>/<assetId>/<name>`.
 */
export function readyObjectKey(organizationId: string, assetId: string, name: string): string {
  return [
    normalizeSegment("organizationId", organizationId),
    normalizeSegment("assetId", assetId),
    normalizeSegment("name", name),
  ].join("/");
}
