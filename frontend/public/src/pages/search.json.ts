import type { APIRoute } from "astro";
import { createFromSource } from "fumadocs-core/search/server";
import { getStructuredData, source } from "@/lib/source";

// `source` only loads entries from the public `docs` collection
// (content/docs), so the emitted index can never surface internal docs.
const server = createFromSource(source, {
  buildIndex(page) {
    return {
      id: page.data._raw.id,
      title: page.data.title,
      description: page.data.description,
      structuredData: getStructuredData(page.data._raw),
      url: page.url,
    };
  },
});

/**
 * GET handler for /search.json. The site builds with `output: "static"`, so
 * Astro prerenders this route into a plain JSON file at build time; the
 * Fumadocs `staticClient` fetch never hits a runtime API.
 */
export const GET: APIRoute = () => {
  return server.staticGET();
};
