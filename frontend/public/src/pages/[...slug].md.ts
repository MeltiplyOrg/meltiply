import type { APIRoute } from "astro";
import type { CollectionEntry } from "astro:content";
import { getMarkdownPath } from "@/lib/markdown";
import { source } from "@/lib/source";

interface Props {
  page: CollectionEntry<"docs">;
}

/**
 * Enumerates every public guide on each build, including `/docs/index.md`.
 * Paths share the index/HTML naming convention; no copied files or separate
 * guide list need maintenance.
 */
export function getStaticPaths() {
  return source.getPages().map((page) => ({
    params: { slug: getMarkdownPath(page.url).slice(1, -3) },
    props: { page: page.data._raw },
  }));
}

/**
 * Prerenders a guide's title, description and complete Markdown body without
 * frontmatter or navigation chrome. The public collection contains plain
 * Markdown in MDX files; preserve its prose, tables, links and code verbatim.
 * Missing retained source fails the build rather than emitting a partial guide.
 */
export const GET: APIRoute<Props> = ({ props: { page } }) => {
  if (page.body === undefined) {
    throw new Error(`Missing Markdown body for public guide: ${page.id}`);
  }
  return new Response(`# ${page.data.title}\n\n${page.data.description}\n\n${page.body.trim()}\n`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
