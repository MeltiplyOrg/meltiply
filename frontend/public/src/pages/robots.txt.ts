import type { APIRoute } from "astro";

export const GET: APIRoute = ({ site }) => {
  const sitemapUrl = new URL("/sitemap-index.xml", site ?? "https://meltiply.com").href;
  return new Response([`User-agent: *`, `Allow: /`, ``, `Sitemap: ${sitemapUrl}`, ``].join("\n"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
