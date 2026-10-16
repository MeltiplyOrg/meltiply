import type { APIRoute } from "astro";
import { getPageTree, source } from "@/lib/source";
import { getMarkdownPath } from "@/lib/markdown";

/**
 * Prerenders /llms.txt from the same public collection and section/order tree
 * as the sidebar, so new guides and metadata edits enter the index on build.
 * Links use the configured site (production by default) and point to generated
 * Markdown guides; this index neither exposes internal docs nor grants crawl access.
 */
export const GET: APIRoute = ({ site }) => {
  const baseUrl = site ?? "https://meltiply.com";
  const pages = source.getPages();
  const pagesByUrl: Record<string, (typeof pages)[number] | undefined> = {};
  for (const page of pages) pagesByUrl[page.url] = page;
  const lines = [
    "# Meltiply documentation",
    "",
    "> Public user guides for Meltiply, a social media scheduling and publishing app with channel management and composer media uploads.",
    "",
    "Use the linked Markdown versions for complete guide content without HTML navigation or scripts.",
  ];

  for (const node of getPageTree().children) {
    if (node.type === "separator") {
      lines.push("", `## ${node.name}`, "");
    } else if (node.type === "page") {
      const page = pagesByUrl[node.url];
      if (!page) continue;
      const url = new URL(getMarkdownPath(page.url), baseUrl).href;
      lines.push(`- [${page.data.title}](${url}): ${page.data.description}`);
    }
  }

  return new Response(`${lines.join("\n")}\n`, {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
};
