import type { MetaData, StaticSource } from "fumadocs-core/source";
import { loader } from "fumadocs-core/source";
import type { Node, Root } from "fumadocs-core/page-tree";
import { type CollectionEntry, getCollection } from "astro:content";
import * as path from "node:path";
import { structure, type StructuredData } from "fumadocs-core/mdx-plugins";

export const source = loader({
  source: await createMySource(),
  baseUrl: "/docs",
});

/**
 * Extract the remark-structure output for one entry so the static search index
 * ships searchable headings and content. `structure()` mirrors the collection's
 * remark pipeline (astro.config.mjs) and requires a string, while the content
 * layer types `body` as optional: data entries and `retainBody: false` entries
 * omit it. An absent body indexes as an empty payload rather than crashing or
 * asserting it away.
 */
export function getStructuredData(entry: CollectionEntry<"docs">): StructuredData {
  if (entry.body === undefined) {
    return { headings: [], contents: [] };
  }
  return structure(entry.body);
}

/**
 * Build a Fumadocs `StaticSource` from the `docs` collection. `SourceConfig`
 * requires both `pageData` and `metaData`; `metaData` stays the base `MetaData`
 * shape because no `meta` files are emitted. `pageData` is the validated
 * frontmatter plus the raw collection entry on `_raw` so pages and the search
 * index can render content and derive structured data — keeping those fields
 * in the config is what makes `source.getPages()` return typed `data`.
 */
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
    // The content layer types `filePath` as optional, but a virtual file needs
    // one to derive its route; entries without it cannot become pages.
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

/**
 * Sidebar display order for the `section` frontmatter enum. Grouped page-tree
 * separators follow this order, so the public IA is controlled here rather
 * than by filename.
 */
const SECTION_ORDER = ["Getting started", "Publishing", "Workspace", "Help", "Legal"] as const;

/**
 * Build the page tree for `DocsLayout` from the section/order frontmatter
 * contract instead of the file-system layout: pages sort by `order` inside
 * labeled section groups, and every page remains a plain link so the whole
 * navigation is reachable without client-side JavaScript.
 */
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
