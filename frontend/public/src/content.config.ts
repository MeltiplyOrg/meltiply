import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";

/**
 * Public documentation pages. Content authors own every file under
 * content/docs; the frontmatter contract below is enforced at build time and
 * by scripts/check-content.mjs. `section` drives the sidebar grouping and
 * `order` sorts pages within a section (see src/lib/source.ts).
 */
const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum(["Getting started", "Publishing", "Workspace", "Help", "Legal"]),
    order: z.number().int().min(0),
  }),
});

export const collections = {
  docs,
};
