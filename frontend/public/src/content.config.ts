import { glob } from "astro/loaders";
import { defineCollection } from "astro:content";
import { z } from "astro/zod";
import catalog from "./lib/docs-catalog.json";

const [firstSection, ...otherSections] = catalog.sections;
if (!firstSection) {
  throw new Error("docs-catalog.json must declare at least one section");
}

const docs = defineCollection({
  loader: glob({ pattern: "**/*.mdx", base: "./content/docs" }),
  schema: z.object({
    title: z.string(),
    description: z.string(),
    section: z.enum([firstSection, ...otherSections]),
    order: z.number().int().min(0),
  }),
});

export const collections = {
  docs,
};
