import axe, { type Result } from "axe-core";

import { ensureStyleTag } from "./dom";

interface AxeViolationNode {
  target: string;
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
  nodeCount: number;
  scannedAt: number;
}

const highlightAttribute = "data-devbox-axe-violation";
const highlightStyleId = "devbox-axe-style";

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

function removeAxeMarks(): void {
  for (const el of document.querySelectorAll(`[${highlightAttribute}]`)) {
    el.removeAttribute(highlightAttribute);
  }
}

export function highlightAxeViolations(result: AxeScanResult): void {
  removeAxeMarks();
  const nodes = result.violations.flatMap((violation) => violation.nodes);
  if (nodes.length === 0) {
    document.getElementById(highlightStyleId)?.remove();
    return;
  }
  ensureStyleTag(
    highlightStyleId,
    `[${highlightAttribute}] { outline: 3px solid var(--red) !important; outline-offset: 2px; }`,
  );
  for (const node of nodes) {
    node.element?.setAttribute(highlightAttribute, "");
  }
}

export function clearAxeHighlights(): void {
  removeAxeMarks();
  document.getElementById(highlightStyleId)?.remove();
}
