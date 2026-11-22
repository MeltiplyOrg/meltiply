const integerPattern = /^\d+$/;

async function cancelQuietly(stream) {
  await Promise.resolve()
    .then(() => stream?.cancel?.())
    .catch(() => {});
}

export async function readBoundedResponseBody(response, maximumBytes, name = "HTTP response") {
  if (!Number.isInteger(maximumBytes) || maximumBytes < 1) {
    throw new TypeError("maximum response bytes must be a positive integer");
  }
  const contentLength = response.headers?.get?.("content-length");
  if (contentLength !== null && contentLength !== undefined) {
    if (!integerPattern.test(contentLength) || Number(contentLength) > maximumBytes) {
      await cancelQuietly(response.body);
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
        await cancelQuietly(reader);
        throw new TypeError(`${name} is too large`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size).toString("utf8");
}

export async function readBoundedJsonResponse(response, maximumBytes, name = "HTTP response") {
  const source = await readBoundedResponseBody(response, maximumBytes, name);
  try {
    return JSON.parse(source);
  } catch {
    throw new TypeError(`${name} must contain valid JSON`);
  }
}
