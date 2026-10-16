// @ts-check
import { defineConfig } from "astro/config";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import tailwindcss from "@tailwindcss/vite";
import mdx from "@astrojs/mdx";
import { unified } from "@astrojs/markdown-remark";
import {
  rehypeCode,
  remarkCodeTab,
  remarkHeading,
  remarkNpm,
  remarkStructure,
} from "fumadocs-core/mdx-plugins";

const publicUrl = process.env.PUBLIC_SITE_URL?.trim() || "https://meltiply.com";

/** @type {import("@astrojs/markdown-remark").UnifiedProcessorOptions["remarkPlugins"]} */
const remarkPlugins = [
  remarkHeading,
  remarkCodeTab,
  remarkNpm,
  [remarkStructure, { exportAs: "structuredData" }],
];
/** @type {import("@astrojs/markdown-remark").UnifiedProcessorOptions["rehypePlugins"]} */
const rehypePlugins = [rehypeCode];

export default defineConfig({
  output: "static",
  site: publicUrl,
  server: { allowedHosts: [new URL(publicUrl).hostname] },
  prefetch: { prefetchAll: true, defaultStrategy: "viewport" },
  markdown: {
    // Fumadocs owns heading ids, indexed structure, and highlighted code.
    syntaxHighlight: false,
    processor: unified({ remarkPlugins, rehypePlugins }),
  },
  integrations: [
    react(),
    mdx({ extendMarkdownConfig: true, syntaxHighlight: false }),
    sitemap({ filter: (page) => !page.includes("/404") }),
  ],
  vite: { plugins: [tailwindcss()] },
});
