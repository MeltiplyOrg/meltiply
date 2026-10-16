/**
 * Reads a streaming HTTP response body into a UTF-8 string with strict size enforcement.
 * Checks Content-Length headers preemptively and streams chunks with a cumulative byte counter,
 * cancelling the stream reader immediately if the payload exceeds `maximumBytes` to protect against
 * memory exhaustion or unbounded upstream responses.
 *
 * @param {Response} response - HTTP Response object
 * @param {number} maximumBytes - Maximum allowed response size in bytes
 * @param {string} [name="HTTP response"] - Contextual label for error messages
 * @returns {Promise<string>} Full response body decoded as a UTF-8 string
 * @throws {TypeError} If maximumBytes is invalid, body is not streamable, or size exceeds limit
 */
export async function readBoundedResponseBody(response, maximumBytes, name = "HTTP response") {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximum response bytes must be a positive integer");
  }
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!/^\d+$/.test(contentLength) || Number(contentLength) > maximumBytes) {
      try {
        await response.body?.cancel?.();
      } catch {
        // The invalid length remains authoritative if cancellation also fails.
      }
      throw new TypeError(`${name} is too large`);
    }
  }
  const reader = response.body?.getReader?.();
  if (!reader) throw new TypeError(`${name} body is not streamable`);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        try {
          await reader.cancel();
        } catch {
          // The size error remains authoritative if cancellation also fails.
        }
        throw new TypeError(`${name} is too large`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

/**
 * Reads a streaming HTTP response body up to a maximum byte threshold and parses it as JSON.
 *
 * @param {Response} response - HTTP Response object
 * @param {number} maximumBytes - Maximum allowed payload size in bytes
 * @param {string} [name="HTTP response"] - Contextual label for error messages
 * @returns {Promise<any>} Parsed JSON value
 * @throws {TypeError} If response exceeds maximumBytes or does not contain valid JSON
 */
export async function readBoundedJsonResponse(response, maximumBytes, name = "HTTP response") {
  const source = await readBoundedResponseBody(response, maximumBytes, name);
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError(`${name} must contain valid JSON`);
  }
}
