import axe, { type Result } from "axe-core";

import { ensureStyleTag } from "./dom";

/**
 * In-browser accessibility scanner for the DevBox Helpers tab.
 *
 * Runs `axe-core` (already a devDependency used by the component test suite)
 * against the live route container and returns flattened, actionable
 * violations. Each violation node can be highlighted on the page and scrolled
 * into view so the offending element is one click away.
 */

interface AxeViolationNode {
  /** CSS selector path to the offending element. */
  target: string;
  /** axe's failure summary for the node. */
  failureSummary: string;
  element: Element | null;
}

interface AxeViolation {
  id: string;
  impact: Result["impact"];
  description: string;
  help: string;
  helpUrl: string;
  nodes: AxeViolationNode[];
}

export interface AxeScanResult {
  violations: AxeViolation[];
  /** Total offending nodes across violations. */
  nodeCount: number;
  /** When the scan ran (epoch ms). */
  scannedAt: number;
}

const highlightAttribute = "data-devbox-axe-violation";
const highlightStyleId = "devbox-axe-style";

/**
 * Runs axe against the application root. The DevBox dock is excluded via
 * `data-devbox` so its own chrome never self-reports.
 */
export async function runAxeScan(
  root: HTMLElement = document.getElementById("root") ?? document.body,
): Promise<AxeScanResult> {
  const results = await axe.run(
    { include: root, exclude: [["[data-devbox]"]] },
    { resultTypes: ["violations"] },
  );
  const violations: AxeViolation[] = results.violations.map((violation) => ({
    id: violation.id,
    impact: violation.impact,
    description: violation.description,
    help: violation.help,
    helpUrl: violation.helpUrl,
    nodes: violation.nodes.map((node) => {
      const target = Array.isArray(node.target) ? node.target.join(" ") : String(node.target);
      return {
        target,
        failureSummary: node.failureSummary ?? "",
        element: document.querySelector(target),
      };
    }),
  }));
  return {
    violations,
    nodeCount: violations.reduce((count, v) => count + v.nodes.length, 0),
    scannedAt: Date.now(),
  };
}

/**
 * Outlines every offending element from a scan result. Pass an empty result
 * (or call `clearAxeHighlights`) to remove the markers.
 */
export function highlightAxeViolations(result: AxeScanResult): void {
  ensureStyleTag(
    highlightStyleId,
    `[${highlightAttribute}] { outline: 3px solid var(--red) !important; outline-offset: 2px; }`,
  );
  clearAxeHighlights();
  for (const violation of result.violations) {
    for (const node of violation.nodes) {
      node.element?.setAttribute(highlightAttribute, "");
    }
  }
}

/**
 * Removes all axe violation outlines.
 */
export function clearAxeHighlights(): void {
  for (const el of document.querySelectorAll(`[${highlightAttribute}]`)) {
    el.removeAttribute(highlightAttribute);
  }
}
