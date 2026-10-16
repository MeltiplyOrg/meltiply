import type { APIRoute } from "astro";

/**
 * Prerendered robots policy for the unified public site: allow public crawls
 * and advertise the sitemap emitted by @astrojs/sitemap.
 */
export const GET: APIRoute = ({ site }) => {
  const sitemapUrl = new URL("/sitemap-index.xml", site ?? "https://meltiply.com").href;
  return new Response([`User-agent: *`, `Allow: /`, ``, `Sitemap: ${sitemapUrl}`, ``].join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
