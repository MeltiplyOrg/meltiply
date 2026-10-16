import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import Ajv from "ajv";
import remarkParse from "remark-parse";
import { unified } from "unified";

const schema = JSON.parse(await readFile(new URL("./pr.schema.json", import.meta.url), "utf8"));
const ajv = new Ajv({ allErrors: true });
const validate = ajv.compile(schema);
const sections = [
  ["summary", "Summary"],
  ["evidence", "Evidence"],
  ["mergeDanger", "Merge Danger"],
  ["qa", "QA"],
];
const typoConfig = fileURLToPath(new URL("../../.typos.toml", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
let mermaid;

/**
 * Initialize the real Mermaid parser only when a PR contains diagrams.
 * Its label sanitizer needs a DOM; an inert, process-local JSDOM supplies it
 * without running scripts, loading remote resources, or launching a browser.
 */
async function diagramParser() {
  if (!mermaid) {
    const { JSDOM } = await import("jsdom");
    const dom = new JSDOM("");
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    mermaid = (await import("mermaid")).default;
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict" });
  }
  return mermaid;
}

/**
 * Validate Mermaid source, including embedded section fences, before publishing.
 * Empty/oversized diagrams, executable configuration, links, HTML, and Markdown
 * fences are rejected; syntax errors retain their section/diagram location.
 * Parser success proves syntax, not visual layout or GitHub version parity.
 */
async function checkDiagram(source, location) {
  if (!source.trim() || source.length > 5000) {
    throw new Error(`${location}: Mermaid source must contain 1–5000 characters.`);
  }
  if (/%%\{|^\s*---|^\s*click\s|<\/?[a-z!]|^\s*(?:`{3,}|~{3,})/im.test(source)) {
    throw new Error(
      `${location}: use plain Mermaid without configuration directives, links, HTML, or code fences.`,
    );
  }
  try {
    await (await diagramParser()).parse(source);
  } catch (error) {
    throw new Error(`${location}: invalid Mermaid: ${error.message}`, {
      cause: error,
    });
  }
}

/**
 * Inspect section Markdown with remark's mdast parser. Walk nested nodes so
 * Mermaid inside lists/quotes is checked too. Generated section headings own
 * levels 1–2; open fences and hidden HTML comments cannot swallow later
 * sections. Summary requires a visible added/removed diff with nonempty "+ "
 * or "- " rows; either direction alone is valid.
 */
async function checkMarkdown(text, location) {
  const ast = unified().use(remarkParse).parse(text);
  const pending = [ast];
  while (pending.length) {
    const node = pending.pop();
    if (node.type === "heading" && node.depth <= 2) {
      throw new Error(`${location}: use level-3+ subheadings; section headings are generated.`);
    }
    if (node.type === "html" && node.value.includes("<!--")) {
      throw new Error(`${location}: put visible review content in sections, not HTML comments.`);
    }
    if (node.type === "code") {
      const raw = text.slice(node.position.start.offset, node.position.end.offset);
      const opening = raw.match(/^(`{3,}|~{3,})/);
      if (opening) {
        const lines = raw.split("\n");
        const closing = lines.at(-1).match(/(?:^|[ >\t])(`{3,}|~{3,})[ \t]*$/);
        if (
          lines.length < 2 ||
          !closing ||
          closing[1][0] !== opening[1][0] ||
          closing[1].length < opening[1].length
        ) {
          throw new Error(`${location}: close every Markdown code fence.`);
        }
      }
      if (node.lang?.toLowerCase() === "mermaid") {
        await checkDiagram(node.value, `${location}, line ${node.position.start.line}`);
      }
    }
    if (node.children) pending.push(...node.children);
  }
  if (location === "sections.summary") {
    let inChanges = false;
    let hasDiff = false;
    for (const node of ast.children) {
      if (node.type === "heading" && node.depth <= 3) {
        inChanges =
          node.depth === 3 &&
          node.children.length === 1 &&
          node.children[0].type === "text" &&
          node.children[0].value === "Added / removed";
      }
      if (!inChanges || node.type !== "code" || node.lang !== "diff") continue;
      const rows = node.value.split(/\r?\n/).filter((row) => row.trim() !== "");
      if (!rows.length || rows.some((row) => !/^[+-] \S/.test(row))) {
        throw new Error(
          `${location}: added/removed diff must contain nonempty "+ " or "- " change descriptions on every nonblank line.`,
        );
      }
      hasDiff = true;
    }
    if (!hasDiff) {
      throw new Error(
        `${location}: include a level-3 "Added / removed" heading with a fenced diff block of "+ " additions or "- " removals.`,
      );
    }
  }
}

/**
 * Check title and complete rendered body with the installed repository spellchecker.
 * The existing project dictionary is authoritative; errors and a missing binary
 * fail closed. The checker reports suggestions but never rewrites factual text.
 */
function checkTypos(title, body) {
  const result = spawnSync(
    "typos",
    [
      "--isolated",
      "--config",
      typoConfig,
      "--threads",
      "1",
      "--color",
      "never",
      "--format",
      "brief",
      "-",
    ],
    { input: `${title}\n\n${body}`, encoding: "utf8", timeout: 30000 },
  );
  if (result.error) {
    throw new Error(
      `Typo check unavailable: ${result.error.message}. Install the repository typos tool.`,
      {
        cause: result.error,
      },
    );
  }
  if (result.status !== 0) {
    throw new Error(`Typo check failed:\n${result.stdout}${result.stderr}`);
  }
}

/**
 * Formats generated PR Markdown with the repository's Vite+ (Oxfmt) toolchain.
 * Runs through `--stdin-filepath` so the markdown parser is selected; nonzero
 * status or an empty result fails before any GitHub call.
 */
function formatMarkdown(markdown) {
  const result = spawnSync(
    join(repoRoot, "node_modules", ".bin", "vp"),
    ["fmt", "--stdin-filepath=.github/PULL_REQUEST_TEMPLATE.md"],
    {
      input: markdown,
      encoding: "utf8",
      cwd: repoRoot,
      timeout: 30000,
    },
  );
  if (result.error || result.status !== 0 || !result.stdout) {
    throw new Error(
      `PR body format failed: ${result.error?.message ?? result.stderr ?? "empty output"}`,
    );
  }
  return result.stdout;
}

/**
 * Turn untrusted structured PR input into the only title/body allowed at creation.
 * All four section keys are required; summary must describe additions/removals in
 * a diff block, while other sections may be empty. Diagrams and Markdown are
 * checked, formatting and typos fail before any GitHub side effect. Attribution
 * comes from validated metadata; callers own truthful evidence and identity.
 */
export async function preparePullRequest(input) {
  if (!validate(input)) {
    throw new Error(`Invalid PR JSON:\n${ajv.errorsText(validate.errors, { separator: "\n" })}`);
  }
  let markdown = "";
  for (const [key, heading] of sections) {
    const text = input.sections[key];
    await checkMarkdown(text, `sections.${key}`);
    markdown += `# ${heading}\n\n${text.replace(/^(?:[ \t]*\r?\n)+/, "").trimEnd()}\n\n`;
    for (const [index, diagram] of (input.diagrams ?? []).entries()) {
      if (diagram.section !== key) continue;
      await checkDiagram(diagram.source, `diagrams[${index}]`);
      markdown += `\`\`\`mermaid\n${diagram.source.trim()}\n\`\`\`\n\n`;
    }
  }
  const { tool, version, model } = input.agent;
  markdown += `- [x] Read \`AGENTS.md\`\n\nPR created using ${tool} v${version} - model ${model}\n`;
  const body = formatMarkdown(markdown);
  if (body !== formatMarkdown(body)) {
    throw new Error("Generated PR Markdown failed the repository Vite+ format check.");
  }
  checkTypos(input.title, body);
  return { title: input.title, body };
}
