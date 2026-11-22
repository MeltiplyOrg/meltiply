#!/usr/bin/env node
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import GithubSlugger from "github-slugger";

const docsRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contentDir = join(docsRoot, "content", "docs");
const catalog = JSON.parse(readFileSync(join(docsRoot, "src", "lib", "docs-catalog.json"), "utf8"));

const SECTIONS = new Set(catalog.sections);
const ALLOWED_SLUGS = new Set(catalog.allowedSlugs);

const FORBIDDEN_NODE_TYPES = new Set([
  "mdxjsEsm",
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxJsxFlowElement",
  "mdxJsxTextElement",
]);

const FORBIDDEN_LINK_HOSTS = /(^|\.)github\.com$/i;

const errors = [];

const parser = unified().use(remarkParse).use(remarkMdx);

function walk(node, visit) {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

function nodeText(node) {
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map(nodeText).join("");
}

function headingSlugs(tree) {
  const slugger = new GithubSlugger();
  const slugs = new Set();
  walk(tree, (node) => {
    if (node.type === "heading") slugs.add(slugger.slug(nodeText(node)));
  });
  return slugs;
}

function splitFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [null, source];
  return [match[1], source.slice(match[0].length)];
}

function checkFrontmatter(slug, frontmatter) {
  if (frontmatter === null) {
    errors.push(`${slug}: missing frontmatter block`);
    return;
  }
  const fields = {};
  for (const line of frontmatter.split("\n")) {
    const match = line.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (match) fields[match[1]] = match[2].trim().replace(/^["']|["']$/g, "");
  }
  for (const key of ["title", "description", "section", "order"]) {
    if (!(key in fields) || fields[key] === "") {
      errors.push(`${slug}: frontmatter missing required '${key}'`);
    }
  }
  if ("section" in fields && !SECTIONS.has(fields.section)) {
    errors.push(`${slug}: section '${fields.section}' is not one of ${[...SECTIONS].join(", ")}`);
  }
  if ("order" in fields && !/^\d+$/.test(fields.order)) {
    errors.push(`${slug}: order must be a non-negative integer`);
  }
}

function checkLink(slug, url, anchorsBySlug) {
  if (url.startsWith("//")) {
    errors.push(`${slug}: protocol-relative link is not allowed: ${url}`);
    return;
  }
  if (url.startsWith("mailto:")) return;
  if (url.startsWith("http://") || url.startsWith("https://")) {
    try {
      if (FORBIDDEN_LINK_HOSTS.test(new URL(url).hostname)) {
        errors.push(`${slug}: link points at the internal repository host: ${url}`);
      }
    } catch {
      errors.push(`${slug}: malformed link URL: ${url}`);
    }
    return;
  }
  if (url.startsWith("#")) {
    const anchor = url.slice(1);
    if (anchor && !anchorsBySlug.get(slug)?.has(anchor)) {
      errors.push(`${slug}: anchor link has no matching heading: ${url}`);
    }
    return;
  }
  if (!url.startsWith("/docs/") && url !== "/docs") {
    errors.push(`${slug}: link must target /docs or external http(s): ${url}`);
    return;
  }
  const [rawPath, anchor] = url.replace(/^\/docs\/?/, "").split("#");
  const pathPart = rawPath === "" ? "index" : rawPath;
  if (!ALLOWED_SLUGS.has(pathPart)) {
    errors.push(
      `${slug}: link is not a public docs page (/docs/, /docs/getting-started, …): ${url}`,
    );
    return;
  }
  if (anchor && !anchorsBySlug.get(pathPart)?.has(anchor)) {
    errors.push(`${slug}: link anchor '#${anchor}' has no matching heading on /docs/${pathPart}`);
  }
}

function checkPage(slug, filePath) {
  const source = readFileSync(filePath, "utf8");
  const [frontmatter, body] = splitFrontmatter(source);
  checkFrontmatter(slug, frontmatter);

  let tree;
  try {
    tree = parser.parse(body);
  } catch (error) {
    errors.push(`${slug}: MDX body fails to parse: ${error.message}`);
    return { slugs: new Set(), links: [] };
  }

  const links = [];
  walk(tree, (node) => {
    if (FORBIDDEN_NODE_TYPES.has(node.type)) {
      const line = node.position?.start?.line ?? "?";
      errors.push(`${slug}:${line}: forbidden MDX node '${node.type}'`);
    }
    if ((node.type === "link" || node.type === "image") && typeof node.url === "string") {
      links.push(node.url);
    }
    if (node.type === "definition" && typeof node.url === "string") {
      links.push(node.url);
    }
  });
  return { slugs: headingSlugs(tree), links };
}

function run() {
  if (!existsSync(contentDir)) {
    errors.push(`missing content directory: ${contentDir}`);
    return 0;
  }

  const pages = new Map();
  for (const entry of readdirSync(contentDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      errors.push(`unexpected directory in content/docs: ${entry.name}`);
      continue;
    }
    if (!entry.name.endsWith(".mdx")) {
      errors.push(`non-MDX file in content/docs: ${entry.name}`);
      continue;
    }
    const slug = entry.name.slice(0, -".mdx".length);
    if (!ALLOWED_SLUGS.has(slug)) {
      errors.push(`unapproved page slug: ${slug} (${entry.name})`);
      continue;
    }
    pages.set(slug, checkPage(slug, join(contentDir, entry.name)));
  }

  for (const slug of ALLOWED_SLUGS) {
    if (!pages.has(slug)) {
      errors.push(`approved page is missing: ${slug}.mdx`);
    }
  }

  const anchorsBySlug = new Map([...pages].map(([slug, data]) => [slug, data.slugs]));
  for (const [slug, data] of pages) {
    for (const url of data.links) checkLink(slug, url, anchorsBySlug);
  }
  return pages.size;
}

const checkedPages = run();

if (errors.length > 0) {
  console.error("Public docs content gate failed:");
  for (const error of errors) console.error(`  - ${error}`);
  process.exit(1);
}
console.log(`Public docs content gate passed (${checkedPages} pages).`);
