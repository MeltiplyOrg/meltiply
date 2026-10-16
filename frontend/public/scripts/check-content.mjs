#!/usr/bin/env node
/**
 * Public-content gate for meltiply.com/docs.
 *
 * Validates the publishing contract for the public docs collection
 * (content/docs) at check time, inside `bun run check`:
 *
 *   - Only .mdx files, directly under content/docs (no nested directories),
 *     and every file must be one of the fixed public page slugs. All 15
 *     approved pages must exist.
 *   - Frontmatter must declare title, description, section (one of the public
 *     sections), and a non-negative integer order — the same contract the
 *     collection schema validates and src/lib/source.ts sorts by.
 *   - Body must be plain markdown. The MDX AST must not contain mdxjsEsm
 *     (import/export), expression nodes (mdxFlowExpression/mdxTextExpression),
 *     or JSX elements (mdxJsxFlowElement/mdxJsxTextElement), so pages cannot
 *     pull in code, components, or evaluated values. Fenced code blocks are
 *     ordinary `code` nodes and stay safe.
 *   - Links must target the public site itself (root-absolute paths into the
 *     15 approved slugs, optionally with an in-page anchor that exists as a
 *     heading on the target page), mailto:, or external http(s) sites —
 *     except the internal repository host, which is rejected. Relative paths,
 *     protocol-relative // URLs, and other schemes are rejected, so internal
 *     repository paths cannot be referenced.
 *
 * This is a bounded source-contract gate for the public collection, not a
 * universal leak guarantee; review of page prose remains a human concern.
 * Usage: node scripts/check-content.mjs
 */
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkMdx from "remark-mdx";
import GithubSlugger from "github-slugger";

const docsRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const contentDir = join(docsRoot, "content", "docs");

const SECTIONS = new Set(["Getting started", "Publishing", "Workspace", "Help", "Legal"]);

/** Every public page is a deliberate, reviewed file — nothing else may ship. */
const ALLOWED_SLUGS = new Set([
  "index",
  "getting-started",
  "workspaces",
  "channels",
  "media",
  "publishing",
  "analytics",
  "inbox",
  "billing",
  "agent",
  "settings",
  "troubleshooting",
  "terms",
  "privacy",
  "cookies",
]);

/** MDX AST node kinds that make content depend on code or evaluated values. */
const FORBIDDEN_NODE_TYPES = new Set([
  "mdxjsEsm",
  "mdxFlowExpression",
  "mdxTextExpression",
  "mdxJsxFlowElement",
  "mdxJsxTextElement",
]);

/** External hosts that carry internal-only material; public pages must not
 * link to them (the monorepo source tree, issues, or internal docs). */
const FORBIDDEN_LINK_HOSTS = /(^|\.)github\.com$/i;

const errors = [];

const parser = unified().use(remarkParse).use(remarkMdx);

/**
 * Walk every node of an mdast tree depth-first and invoke `visit` on each.
 * mdast children always live under `children`, so a single generic walker is
 * enough — no per-node-type dispatch needed.
 */
function walk(node, visit) {
  visit(node);
  if (Array.isArray(node.children)) {
    for (const child of node.children) walk(child, visit);
  }
}

/**
 * Concatenate the plain text of a heading's inline children. Used for anchor
 * slugs; text and inlineCode carry `value`, richer inline nodes are flattened
 * recursively so link text inside headings still contributes.
 */
function nodeText(node) {
  if (typeof node.value === "string") return node.value;
  if (!Array.isArray(node.children)) return "";
  return node.children.map(nodeText).join("");
}

/**
 * Collect the GitHub-style anchor slugs of every heading in one AST.
 * remark-heading (fumadocs pipeline) uses github-slugger semantics, so
 * matching it here keeps link validation aligned with emitted heading ids.
 */
function headingSlugs(tree) {
  const slugger = new GithubSlugger();
  const slugs = new Set();
  walk(tree, (node) => {
    if (node.type === "heading") slugs.add(slugger.slug(nodeText(node)));
  });
  return slugs;
}

/**
 * Extract the frontmatter block (--- ... ---) from raw file source.
 * Returns [frontmatterText, bodyText]; frontmatterText is null when absent so
 * callers can report the missing block instead of validating nothing.
 */
function splitFrontmatter(source) {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match) return [null, source];
  return [match[1], source.slice(match[0].length)];
}

/**
 * Validate the flat key: value frontmatter contract for one page. Only
 * top-level scalars are expected, so a line parser suffices — richer YAML is
 * out of contract anyway.
 */
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

/**
 * Validate one link/image target found in the AST. Public pages may link to
 * other public pages (/docs/slug or /docs/slug#anchor, verified against the real
 * page set and heading anchors), to mailto:, or to external http(s) hosts
 * other than the internal repository. Everything else — relative paths,
 * protocol-relative //, paths outside /docs, unknown paths, other schemes — is
 * rejected so navigation cannot point at non-public or non-existent targets.
 */
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
  // "/docs/" targets the docs home page, emitted from index.mdx.
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

/**
 * Validate one content file: frontmatter contract, then MDX-AST checks for
 * forbidden code/component nodes, heading-anchor collection, and link target
 * collection. Link checks run in a second pass (run()) once all pages'
 * anchors are known, so this function returns the collected data.
 */
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

/**
 * Validate the whole public collection: directory shape, per-page checks, the
 * presence of every approved slug, and finally cross-page link targets using
 * the anchors collected from each page's own AST. Returns the number of
 * validated pages (0 when the content directory is absent).
 */
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
