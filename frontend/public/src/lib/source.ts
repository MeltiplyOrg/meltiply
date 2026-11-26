import type { MetaData, StaticSource } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";
import type { Node, Root } from "fumadocs-core/page-tree";
import { type CollectionEntry, getCollection } from "astro:content";
import * as path from "node:path";
import { structure, type StructuredData } from "fumadocs-core/mdx-plugins";
import catalog from "./docs-catalog.json";

export const source = loader({
  source: await createMySource(),
  baseUrl: "/docs",
});

export function getStructuredData(entry: CollectionEntry<"docs">): StructuredData {
  if (entry.body === undefined) {
    return { headings: [], contents: [] };
  }
  return structure(entry.body);
}

async function createMySource() {
  const out: StaticSource<{
    metaData: MetaData;
    pageData: CollectionEntry<"docs">["data"] & {
      _raw: CollectionEntry<"docs">;
    };
  }> = {
    files: [],
  };

  for (const page of await getCollection("docs")) {
    if (page.filePath === undefined) continue;
    const virtualPath = path.relative("content/docs", page.filePath);

    out.files.push({
      type: "page",
      path: virtualPath,
      data: {
        ...page.data,
        _raw: page,
      },
    });
  }

  return out;
}

const SECTION_ORDER: readonly string[] = catalog.sections;

export function getPageTree(): Root {
  const children: Node[] = [];

  for (const section of SECTION_ORDER) {
    const pages = source
      .getPages()
      .filter((page) => page.data.section === section)
      .sort((a, b) => a.data.order - b.data.order || a.data.title.localeCompare(b.data.title));

    if (pages.length === 0) continue;

    children.push({
      $id: `section-${section}`,
      type: "separator",
      name: section,
    });
    children.push(
      ...pages.map((page) => ({
        $id: page.url,
        type: "page" as const,
        name: page.data.title,
        url: page.url,
      })),
    );
  }

  return {
    $id: "root",
    name: "Meltiply docs",
    children,
  };
}
