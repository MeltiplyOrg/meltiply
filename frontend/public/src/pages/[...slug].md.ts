import type { APIRoute } from "astro";
import type { CollectionEntry } from "astro:content";
import { getMarkdownPath } from "@/lib/markdown";
import { source } from "@/lib/source";

interface Props {
  page: CollectionEntry<"docs">;
}

export function getStaticPaths() {
  return source.getPages().map((page) => ({
    params: { slug: getMarkdownPath(page.url).slice(1, -3) },
    props: { page: page.data._raw },
  }));
}

export const GET: APIRoute<Props> = ({ props: { page } }) => {
  if (page.body === undefined) {
    throw new Error(`Missing Markdown body for public guide: ${page.id}`);
  }
  return new Response(`# ${page.data.title}\n\n${page.data.description}\n\n${page.body.trim()}\n`, {
    headers: { "content-type": "text/markdown; charset=utf-8" },
  });
};
