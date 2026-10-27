/** Serves only preview assets, rejecting every API/telemetry request even when browser mocking fails. No upstream binding or fetch exists. */
async function fetchPreview(
  request: Request,
  env: Pick<CloudflareEnv, "ASSETS">,
): Promise<Response> {
  const path = new URL(request.url).pathname;
  const response =
    /^\/api(?:\/|$)/.test(path) || path === "/__frontend-telemetry"
      ? Response.json(
          {
            error: {
              code: "preview_isolated",
              message: "UI preview has no backend. Browser fixtures must handle this request.",
              request_id: "ui-preview",
              retryable: false,
              details: [],
            },
          },
          { status: 503 },
        )
      : await env.ASSETS.fetch(request);
  const headers = new Headers(response.headers);
  headers.set(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; media-src 'self' blob:; connect-src 'self' blob:; worker-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
  );
  headers.set("X-Robots-Tag", "noindex, nofollow");
  headers.set("Cache-Control", "no-store");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default { fetch: fetchPreview };
