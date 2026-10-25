import { Languages } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { SegmentedControl } from "@meltiply/ui/segmented-control";
import { Switch } from "@meltiply/ui/switch";
import { useI18n, supportedLanguages, type Language } from "@/lib/i18n";
import { isPseudoLocalized, setPseudoLocalization } from "@/lib/pseudo-locale";
import { cn } from "@meltiply/ui/utils";

import {
  clearAxeHighlights,
  highlightAxeViolations,
  runAxeScan,
  type AxeScanResult,
} from "./axe-scan";
import { clearRuntimeStatus, simulateAuthExpired, simulateOffline } from "./chaos";
import { overlayState, setBaselineGrid, setElementOutlines } from "./layout-overlays";
import {
  auditTokenColors,
  clearTokenHighlights,
  collectTokenColors,
  highlightTokenViolations,
  inspectElementColors,
  type ElementColorReport,
  type TokenViolation,
} from "./token-audit";

const pickerHighlightId = "devbox-picker-highlight";

/**
 * Removes every transient Helpers-tab DOM mutation: the element-picker outline,
 * token-audit marks, and axe outlines plus their stylesheets. Called when the
 * tab or dock unmounts so inspections never outlive their control surface.
 */
export function clearHelpersDom(): void {
  document.getElementById(pickerHighlightId)?.remove();
  clearTokenHighlights();
  clearAxeHighlights();
}

/**
 * Ensures the floating element-picker highlight box exists; returns it.
 */
function pickerHighlight(): HTMLDivElement {
  let el = document.getElementById(pickerHighlightId) as HTMLDivElement | null;
  if (!el) {
    el = document.createElement("div");
    el.id = pickerHighlightId;
    el.setAttribute("aria-hidden", "true");
    el.setAttribute(
      "style",
      "position:fixed;pointer-events:none;z-index:2147483646;border:2px solid var(--accent);border-radius:4px;display:none",
    );
    document.body.appendChild(el);
  }
  return el;
}

/**
 * Helpers tab: design-system, accessibility, i18n, and chaos tools.
 *
 * - Token inspector: hover-pick an element to see which design tokens its
 *   computed colors resolve to; "Audit page" flags every element whose colors
 *   fall outside the declared token ramp (the runtime analogue of the
 *   `@shadcn/lint` `no-raw-colors` rule).
 * - Accessibility: one-click `axe-core` scan of the route container with
 *   per-violation element highlighting.
 * - Layout: 8px baseline grid and element boundary outline overlays.
 * - i18n: language switching plus the pseudo-localization expander.
 * - Chaos: auth-expired and offline runtime statuses plus a synthetic render
 *   error for the root error boundary.
 */
export function HelpersTab(): React.ReactElement {
  const { language, setLanguage } = useI18n();
  const [picking, setPicking] = useState(false);
  const [picked, setPicked] = useState<ElementColorReport[] | null>(null);
  const [violations, setViolations] = useState<TokenViolation[] | null>(null);
  const [axeResult, setAxeResult] = useState<AxeScanResult | null>(null);
  const [axeRunning, setAxeRunning] = useState(false);
  const [overlays, setOverlays] = useState(overlayState);
  const [pseudo, setPseudo] = useState(isPseudoLocalized());
  const [crash, setCrash] = useState(false);
  const mountedRef = useRef(true);

  // Highlights and the picker outline are owned by this tab; clear them when
  // it unmounts instead of leaving temporary marks on the page. Async scans
  // check the ref so a late result neither updates state nor reapplies marks.
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearHelpersDom();
    };
  }, []);

  // Element picker: track the hovered element with a floating outline; a click
  // freezes the selection and reports its token usage. Esc cancels.
  useEffect(() => {
    if (!picking) return;
    const highlight = pickerHighlight();
    const onMove = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest("[data-devbox]")) return;
      const rect = target.getBoundingClientRect();
      highlight.style.display = "block";
      highlight.style.left = `${rect.left}px`;
      highlight.style.top = `${rect.top}px`;
      highlight.style.width = `${rect.width}px`;
      highlight.style.height = `${rect.height}px`;
    };
    const onClick = (event: MouseEvent) => {
      const target = event.target as Element | null;
      if (!target || target.closest("[data-devbox]")) return;
      event.preventDefault();
      event.stopPropagation();
      setPicked(inspectElementColors(target, collectTokenColors()));
      setPicking(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setPicking(false);
    };
    document.addEventListener("mousemove", onMove, true);
    document.addEventListener("click", onClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      highlight.remove();
      document.removeEventListener("mousemove", onMove, true);
      document.removeEventListener("click", onClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [picking]);

  const runTokenAudit = () => {
    const found = auditTokenColors(collectTokenColors());
    setViolations(found);
    highlightTokenViolations(found);
  };
  const runAxe = async () => {
    setAxeRunning(true);
    try {
      const result = await runAxeScan();
      if (!mountedRef.current) return;
      setAxeResult(result);
      highlightAxeViolations(result);
    } catch (error) {
      // axe.run can reject and querySelector throws on malformed targets —
      // surface the failure in the log instead of leaking an unhandled
      // rejection.
      console.error("DevBox axe scan failed:", error);
      if (mountedRef.current) setAxeResult(null);
    } finally {
      if (mountedRef.current) setAxeRunning(false);
    }
  };

  if (crash) {
    // Deliberate render error: exercises the root FrontendErrorBoundary and its
    // "Reload workspace" recovery path.
    throw new Error("DevBox chaos: synthetic render error");
  }

  return (
    <div className="flex flex-col gap-3 text-[12px]">
      <p className="text-[10px] font-semibold uppercase tracking-wide text-ink-3">Design tokens</p>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Element picker</span>
        <Switch checked={picking} onCheckedChange={setPicking} aria-label="Toggle token picker" />
      </div>
      {picked && (
        <ul className="flex flex-col gap-1 rounded-control bg-inset p-2 font-mono text-[11px]">
          {picked.length === 0 && <li className="text-ink-3">No painted colors on element.</li>}
          {picked.map((report) => (
            <li key={report.property} className="flex items-center gap-2">
              <span
                className="inline-block size-3 rounded-chip border border-line"
                style={{ backgroundColor: report.computed }}
              />
              <span className="text-ink-2">{report.property}</span>
              <span className={cn("truncate", report.tokens.length ? "text-green" : "text-red")}>
                {report.tokens.length ? report.tokens.join(", ") : report.computed}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Token audit</span>
        <button
          type="button"
          onClick={runTokenAudit}
          className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover"
        >
          Audit page
        </button>
      </div>
      {violations !== null && (
        <p className={cn("text-[11px]", violations.length ? "text-red" : "text-green")}>
          {violations.length === 0
            ? "All painted colors resolve to design tokens."
            : `${violations.length} element(s) use non-token colors — outlined in red.`}
        </p>
      )}

      <p className="border-t border-line pt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        Accessibility
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">axe scan</span>
        <span className="flex gap-1.5">
          {axeResult && (
            <button
              type="button"
              onClick={() => {
                clearAxeHighlights();
                setAxeResult(null);
              }}
              className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover"
            >
              Clear
            </button>
          )}
          <button
            type="button"
            onClick={() => void runAxe()}
            disabled={axeRunning}
            className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover disabled:opacity-50"
          >
            {axeRunning ? "Scanning…" : "Scan route"}
          </button>
        </span>
      </div>
      {axeResult && (
        <ul className="flex max-h-40 flex-col gap-1 overflow-y-auto">
          {axeResult.violations.length === 0 && (
            <li className="text-[11px] text-green">No violations found.</li>
          )}
          {axeResult.violations.map((violation) => (
            <li key={violation.id} className="rounded-control bg-inset px-2 py-1">
              <details>
                <summary className="cursor-pointer text-[11px] font-medium text-ink">
                  <span className="mr-1 rounded-chip bg-red-tint px-1.5 py-0.5 text-[10px] font-semibold uppercase text-red">
                    {violation.impact ?? "?"}
                  </span>
                  {violation.help} ({violation.nodes.length})
                </summary>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {violation.nodes.map((node, index) => (
                    <li key={index}>
                      <button
                        type="button"
                        onClick={() => node.element?.scrollIntoView({ block: "center" })}
                        className="w-full truncate rounded-chip bg-page px-1.5 py-0.5 text-left font-mono text-[10px] text-ink-2 hover:bg-hover"
                      >
                        {node.target}
                      </button>
                    </li>
                  ))}
                </ul>
              </details>
            </li>
          ))}
        </ul>
      )}

      <p className="border-t border-line pt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        Layout
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">8px grid</span>
        <Switch
          checked={overlays.grid}
          onCheckedChange={(next) => {
            setBaselineGrid(next);
            setOverlays(overlayState());
          }}
          aria-label="Toggle baseline grid"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Element outlines</span>
        <Switch
          checked={overlays.outlines}
          onCheckedChange={(next) => {
            setElementOutlines(next);
            setOverlays(overlayState());
          }}
          aria-label="Toggle element outlines"
        />
      </div>

      <p className="border-t border-line pt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        <Languages className="mr-1 inline size-3" aria-hidden />
        i18n
      </p>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Language</span>
        <SegmentedControl
          options={supportedLanguages.map(({ code }) => code)}
          value={language}
          onChange={(code) => setLanguage(code as Language)}
          label="Language"
          className="h-7"
        />
      </div>
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Pseudo-localize</span>
        <Switch
          checked={pseudo}
          onCheckedChange={(next) => {
            setPseudoLocalization(next);
            setPseudo(next);
          }}
          aria-label="Toggle pseudo-localization"
        />
      </div>

      <p className="border-t border-line pt-3 text-[10px] font-semibold uppercase tracking-wide text-ink-3">
        Chaos
      </p>
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={simulateAuthExpired}
          className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover"
        >
          Expire session
        </button>
        <button
          type="button"
          onClick={() => simulateOffline(true)}
          className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover"
        >
          Go offline
        </button>
        <button
          type="button"
          onClick={() => {
            simulateOffline(false);
            clearRuntimeStatus();
          }}
          className="rounded-control border border-line bg-inset px-2.5 py-1 font-medium text-ink-2 hover:bg-hover"
        >
          Recover
        </button>
      </div>
      <button
        type="button"
        onClick={() => setCrash(true)}
        className="self-start rounded-control border border-red/40 bg-red-tint px-2.5 py-1 font-medium text-red hover:bg-red/10"
      >
        Crash this render
      </button>
    </div>
  );
}
