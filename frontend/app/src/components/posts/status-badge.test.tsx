// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { I18nProvider } from "@/lib/i18n";
import { StatusBadge } from "./status-badge";

afterEach(cleanup);

const LABELS: Record<string, string> = {
  awaiting_provider: "Awaiting provider",
  cancel_requested: "Cancellation requested",
  cancelled: "Cancelled",
  draft: "Draft",
  failed: "Failed",
  needs_reconciliation: "Needs reconciliation",
  processing: "Processing",
  published: "Published",
  queued: "Queued",
  scheduled: "Scheduled",
  unknown: "Unknown",
};

/** Renders one badge through the real i18n provider and returns its shared pill. */
function renderBadge(status: string) {
  render(
    <I18nProvider>
      <StatusBadge status={status} />
    </I18nProvider>,
  );
  return screen.getByText(LABELS[status.toLowerCase()] ?? "Unknown").parentElement!;
}

describe("StatusBadge", () => {
  it.each([
    { status: "published", tone: "bg-green-tint", dot: "bg-green" },
    { status: "failed", tone: "bg-red-tint", dot: "bg-red" },
    { status: "needs_reconciliation", tone: "bg-orange-tint", dot: "bg-orange" },
    { status: "cancel_requested", tone: "bg-orange-tint", dot: "bg-orange" },
    { status: "scheduled", tone: "bg-accent-tint", dot: "bg-accent" },
    { status: "queued", tone: "bg-accent-tint", dot: "bg-accent" },
    { status: "processing", tone: "bg-accent-tint", dot: "bg-accent" },
    { status: "awaiting_provider", tone: "bg-accent-tint", dot: "bg-accent" },
    { status: "draft", tone: "bg-inset", dot: "bg-ink-3" },
    { status: "cancelled", tone: "bg-inset", dot: "bg-ink-3" },
    { status: "unknown", tone: "bg-inset", dot: "bg-ink-3" },
  ] as const)("renders $status with its canonical tone", ({ status, tone, dot }) => {
    const pill = renderBadge(status);

    expect(pill).toHaveClass(tone);
    expect(pill.firstElementChild).toHaveClass(dot);
  });

  it("renders an unrecognized value as a neutral Unknown badge, never a scheduled one", () => {
    const pill = renderBadge("future_provider_status");

    expect(screen.getByText("Unknown")).toBeInTheDocument();
    expect(pill).toHaveClass("bg-inset");
    expect(pill).not.toHaveClass("bg-accent-tint");
    expect(screen.queryByText("Scheduled")).not.toBeInTheDocument();
  });

  it("normalizes case so a provider's uppercase outcome keeps its truthful tone", () => {
    const pill = renderBadge("PUBLISHED");

    expect(screen.getByText("Published")).toBeInTheDocument();
    expect(pill).toHaveClass("bg-green-tint");
  });

  it("updates the visible tone and label when a Channel outcome transitions", () => {
    const { rerender } = render(
      <I18nProvider>
        <StatusBadge status="processing" />
      </I18nProvider>,
    );
    expect(screen.getByText("Processing").parentElement).toHaveClass("bg-accent-tint");

    rerender(
      <I18nProvider>
        <StatusBadge status="needs_reconciliation" />
      </I18nProvider>,
    );
    expect(screen.queryByText("Processing")).not.toBeInTheDocument();
    expect(screen.getByText("Needs reconciliation").parentElement).toHaveClass("bg-orange-tint");

    rerender(
      <I18nProvider>
        <StatusBadge status="published" />
      </I18nProvider>,
    );
    expect(screen.queryByText("Needs reconciliation")).not.toBeInTheDocument();
    expect(screen.getByText("Published").parentElement).toHaveClass("bg-green-tint");
  });
});
