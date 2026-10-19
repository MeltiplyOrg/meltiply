import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { RuleTester } from "vite-plus/lint/plugins-dev";
import boundariesPlugin from "../../lint/boundaries-plugin.mjs";
import { checkAstroSource } from "../../lint/astro-ui-contract.mjs";

// Oxlint's RuleTester drives the same rule objects the linter loads via
// lint.jsPlugins, so these cases exercise the exact policy code `vp lint`
// runs — the suite the old ESLint-based test verified. RuleTester delegates
// its scenario wrappers to whatever runner provides describe/it.
RuleTester.describe = describe;
RuleTester.it = it;

const appRoot = dirname(fileURLToPath(import.meta.url));
const ruleTester = new RuleTester({ cwd: appRoot });
/**
 * Feature-component path used by every case: it lands inside `src/` so the
 * rules run, while staying outside every adapter/directory exemption the
 * rules check on `context.filename` (`.test.` / `src/test/` /
 * `platform-icon.tsx` / canonical component dirs / devbox).
 */
const featureFile = `${appRoot}/src/components/example.tsx`;

/** Wraps a class list as a string literal, the node type both color rules inspect. */
function classSnippet(classes: string): string {
  return `export const classes = "${classes}";`;
}

const paletteRule = boundariesPlugin.rules["no-raw-palette-utility"];
const providerRule = boundariesPlugin.rules["no-provider-color-leak"];
const rawControlsRule = boundariesPlugin.rules["no-raw-interactive-elements"];
const cloneGuardRule = boundariesPlugin.rules["no-canonical-ui-clones"];

/** Canonical shared-library path modeled as a real normalized filename. */
const sharedUiFile = resolve(appRoot, "../shared/src/components/ui/example.tsx");
const sharedAtomsFile = resolve(appRoot, "../shared/src/components/atoms/example.tsx");

ruleTester.run("boundaries/no-raw-palette-utility", paletteRule, {
  valid: [
    // Non-color utilities: size/style slots that must not read as palette steps.
    ...[
      "shadow-md",
      "dark:shadow-2xl",
      "divide-x-2",
      "border-t-2",
      "border-x-0",
      "outline-2",
      "outline-offset-2",
      "ring-offset-2",
      "decoration-2",
      "decoration-dashed",
      "accent-auto",
      "bg-linear-45",
      "bg-conic-90",
      "dark:bg-conic-180",
      "divide-x-12",
      "divide-y-24",
      "outline-offset-12",
      "inset-ring-2",
      "inset-shadow-sm",
      "drop-shadow-lg",
    ].map((classes) => ({
      name: `keeps allowing the non-color ${classes} utility`,
      code: classSnippet(classes),
      filename: featureFile,
    })),
    // Theme tokens resolve through globals.css and are always allowed.
    ...[
      "dark:fill-ink",
      "hover:bg-hover/40",
      "data-[highlighted]:text-red",
      "focus-visible:ring-ink/30",
      "bg-surface text-ink",
      "shadow-card",
      "caret-accent",
      "accent-ink",
      "decoration-red",
      "divide-line",
      "outline-accent",
      "ring-offset-field",
      "border-t-line-strong",
      "dark:border-b-line",
      "inset-ring-line",
      "inset-shadow-card",
      "drop-shadow-card",
    ].map((classes) => ({
      name: `keeps allowing the theme-token ${classes} utility`,
      code: classSnippet(classes),
      filename: featureFile,
    })),
  ],
  invalid: [
    // Variant prefixes (hover:/dark:/data-[...]/) cannot smuggle a raw step.
    ...[
      "dark:fill-white",
      "hover:bg-red-500",
      "dark:hover:text-slate-100",
      "data-[state=open]:bg-black",
      "group-hover:from-zinc-900",
      "hover:bg-white!",
      "dark:shadow-red-500",
      "hover:caret-blue-600",
      "accent-green-500",
      "dark:hover:decoration-rose-500",
      "data-[state=open]:divide-blue-400",
      "focus-visible:outline-orange-500",
      "dark:ring-offset-slate-900",
      "sm:border-t-red-500",
      "dark:hover:border-b-indigo-400",
      "data-[highlighted]:border-x-cyan-600",
      "supports-[display:grid]:border-e-emerald-600",
      "dark:inset-ring-blue-500",
      "hover:inset-shadow-cyan-600",
      "data-[state=open]:drop-shadow-amber-400",
    ].map((classes) => ({
      name: `rejects the variant-prefixed raw palette utility ${classes}`,
      code: classSnippet(classes),
      filename: featureFile,
      errors: [{ messageId: "restricted" }],
    })),
    ...[
      "fill-white",
      "bg-red-500/40",
      "text-slate-100",
      "shadow-black/40",
      "caret-white",
      "decoration-black",
      "divide-zinc-200",
      "outline-white/60",
      "ring-offset-black",
      "border-l-amber-400",
      "border-y-neutral-300",
      "border-s-violet-500",
      "inset-ring-white",
      "inset-shadow-slate-900/50",
      "drop-shadow-black",
    ].map((classes) => ({
      name: `still rejects the bare raw palette utility ${classes}`,
      code: classSnippet(classes),
      filename: featureFile,
      errors: [{ messageId: "restricted" }],
    })),
  ],
});

ruleTester.run("boundaries/no-provider-color-leak", providerRule, {
  valid: [
    ...["platform-tiktok", "hover:bg-hover", "text-ink"].map((classes) => ({
      name: `keeps allowing ${classes}`,
      code: classSnippet(classes),
      filename: featureFile,
    })),
  ],
  invalid: [
    ...[
      "hover:bg-platform-tiktok",
      "dark:text-platform-youtube",
      "group-hover:fill-platform-instagram",
      "dark:border-platform-linkedin",
      "sm:border-t-platform-youtube",
      "dark:ring-platform-instagram",
      "focus-visible:ring-offset-platform-tiktok",
      "dark:inset-ring-platform-linkedin",
      "group-hover:from-platform-youtube",
      "dark:via-platform-instagram",
      "hover:to-platform-tiktok",
      "dark:shadow-platform-linkedin",
      "dark:inset-shadow-platform-youtube",
      "dark:caret-platform-tiktok",
      "dark:accent-platform-linkedin",
      "hover:decoration-platform-youtube",
      "dark:divide-platform-instagram",
      "focus-visible:outline-platform-tiktok",
      "dark:stroke-platform-linkedin",
    ].map((classes) => ({
      name: `rejects the variant-prefixed provider utility ${classes}`,
      code: classSnippet(classes),
      filename: featureFile,
      errors: [{ messageId: "restricted" }],
    })),
    {
      name: "still rejects the bare provider utility bg-platform-tiktok",
      code: classSnippet("bg-platform-tiktok"),
      filename: featureFile,
      errors: [{ messageId: "restricted" }],
    },
  ],
});

/**
 * Exercises the root `vite.config.ts` lint policy end-to-end — core
 * `no-restricted-imports`, `no-alert`, and `no-restricted-properties` overrides
 * plus the `boundaries/*` ownership rules loaded through `lint.jsPlugins` —
 * since the core rules are config-level and the RuleTester cannot drive them.
 * These cases lint one batch of temporary fixture files through `vp lint`
 * itself. Each run gets its own `src/components/` directory so the feature
 * override matches without colliding with another run. The directory is
 * deleted in `afterAll`, including on assertion failures.
 */
describe("shared UI import contract", () => {
  const repoRoot = resolve(appRoot, "../..");
  const vpBin = join(repoRoot, "node_modules", "vite-plus", "bin", "vp");
  let fixturesDir: string | undefined;
  const toastSources = ["sonner", "react-hot-toast", "react-toastify", "sileo"];
  const radixSources = [
    "@radix-ui/react-dialog",
    "@radix-ui/react-alert-dialog",
    "@radix-ui/react-tooltip",
  ];
  const fixtures: Record<string, string> = Object.fromEntries([
    ...toastSources.map((source): [string, string] => [
      `toast-${source}.tsx`,
      `import { toast } from "${source}";\nexport { toast };\n`,
    ]),
    ...radixSources.map((source): [string, string] => [
      `radix-${source.replace("@radix-ui/react-", "")}.tsx`,
      `import { Root } from "${source}";\nexport { Root };\n`,
    ]),
    ["alert.tsx", 'alert("Copied");\n'] as const,
    ["clipboard.tsx", 'navigator.clipboard.writeText("id");\n'] as const,
    [
      "obsolete-ui-import.tsx",
      'import { Button } from "@/components/ui/button";\nexport { Button };\n',
    ] as const,
    ["obsolete-reexport.tsx", 'export { Button } from "@/components/ui/button";\n'] as const,
    [
      "deep-shared-import.tsx",
      'import { Button } from "@meltiply/ui/src/components/ui/button";\nexport { Button };\n',
    ] as const,
    ["retired-dialog.tsx", 'export { DialogContent } from "@meltiply/ui/dialog";\n'] as const,
    [
      "allowed-wrappers.tsx",
      'import { CenterDialogContent } from "@meltiply/ui/center-dialog";\n' +
        'import { SideDialog } from "@meltiply/ui/side-dialog";\n' +
        'import { toast } from "@meltiply/ui/toast";\n' +
        "export { CenterDialogContent, SideDialog, toast };\n",
    ] as const,
  ]);

  /** Diagnostic codes emitted per fixture file, populated by lintFixtures(). */
  let diagnosticsByFile = new Map<string, string[]>();

  /**
   * Writes every fixture and lints the directory in a single `vp lint` run —
   * repeated CLI invocations would each pay the cold compiler startup. The JSON
   * output uses `eslint(rule)` codes for core rules and `typescript(TSxxxx)`
   * for type diagnostics; both are preserved, callers assert on specific codes.
   * A nonzero exit merely means diagnostics were found, so stdout is used even
   * when the child reports failure.
   */
  function lintFixtures(): Map<string, string[]> {
    fixturesDir = mkdtempSync(join(appRoot, "src", "components", "lint-contract-"));
    for (const [file, source] of Object.entries(fixtures)) {
      writeFileSync(join(fixturesDir, file), source);
    }
    const result = spawnSync(
      process.execPath,
      [vpBin, "lint", relative(repoRoot, fixturesDir), "--format=json"],
      // Type-aware cold lint competes with the parallel suite; 10s timed out under load.
      { cwd: repoRoot, encoding: "utf8", timeout: 120_000 },
    );
    const stdout = result.stdout ?? "";
    const jsonStart = stdout.indexOf("{");
    if (jsonStart === -1) {
      throw new Error(
        `vp lint produced no JSON output (status ${result.status}): ${result.error?.message ?? ""}\n${result.stderr}`,
      );
    }
    const report = JSON.parse(stdout.slice(jsonStart)) as {
      diagnostics?: { code?: string; filename?: string }[];
    };
    const grouped = new Map<string, string[]>();
    for (const diagnostic of report.diagnostics ?? []) {
      if (!diagnostic.filename || !diagnostic.code) continue;
      const file = basename(diagnostic.filename);
      grouped.set(file, [...(grouped.get(file) ?? []), diagnostic.code]);
    }
    return grouped;
  }

  /** Returns the ESLint-style rule ids reported for one fixture file. */
  function ruleIdsFor(file: string): string[] {
    return (diagnosticsByFile.get(file) ?? [])
      .filter((code) => code.startsWith("eslint("))
      .map((code) => code.slice("eslint(".length, -1));
  }

  beforeAll(() => {
    diagnosticsByFile = lintFixtures();
  }, 130_000);

  afterAll(() => {
    if (fixturesDir) rmSync(fixturesDir, { recursive: true, force: true });
  });

  it.each(toastSources)("rejects the parallel notification store %s", (source) => {
    expect(ruleIdsFor(`toast-${source}.tsx`)).toContain("no-restricted-imports");
  });

  it.each(radixSources)("rejects bypassing the feature wrapper with %s", (source) => {
    expect(ruleIdsFor(`radix-${source.replace("@radix-ui/react-", "")}.tsx`)).toContain(
      "no-restricted-imports",
    );
  });

  it("rejects native notifications outside the shared feedback store", () => {
    expect(ruleIdsFor("alert.tsx")).toContain("no-alert");
  });

  it("rejects feature-local clipboard implementations", () => {
    expect(ruleIdsFor("clipboard.tsx")).toContain("no-restricted-properties");
  });

  it("rejects obsolete app ui specifiers", () => {
    expect(ruleIdsFor("obsolete-ui-import.tsx")).toContain("no-restricted-imports");
  });

  it("rejects re-export shims through obsolete ui specifiers", () => {
    expect(ruleIdsFor("obsolete-reexport.tsx")).toContain("no-restricted-imports");
  });

  it("rejects deep @meltiply/ui internals specifiers", () => {
    expect(ruleIdsFor("deep-shared-import.tsx")).toContain("no-restricted-imports");
  });

  it("rejects the retired dialog names", () => {
    expect(ruleIdsFor("retired-dialog.tsx")).toContain("no-restricted-imports");
  });
  it("allows the canonical dialog and notification imports", () => {
    expect(ruleIdsFor("allowed-wrappers.tsx")).not.toContain("no-restricted-imports");
  });
});

ruleTester.run("boundaries/no-raw-interactive-elements", rawControlsRule, {
  // Feature code and the retired app component dirs (which only hold
  // composition wrappers now) must reuse the canonical controls: the
  // raw-element exemption is limited to `frontend/shared/src/components/`
  // plus devbox chrome and tests.
  valid: [
    {
      name: "allows a control implementation inside the canonical shared ui dir",
      code: "export const Control = () => <button>Toggle</button>;",
      filename: sharedUiFile,
    },
    {
      name: "allows a control implementation in canonical public controls",
      code: "export const Control = () => <button>Toggle</button>;",
      filename: resolve(appRoot, "../shared/src/components/public/example.tsx"),
    },
    {
      name: "allows bespoke controls in the devbox chrome boundary",
      code: "export const Control = () => <button>Toggle</button>;",
      filename: `${appRoot}/src/components/devbox/example.tsx`,
    },
    {
      name: "allows a control implementation inside a test file",
      code: "export const Control = () => <button>Toggle</button>;",
      filename: `${appRoot}/src/components/posts/example.test.tsx`,
    },
  ],
  invalid: [
    {
      name: "rejects a raw control in a feature component",
      code: "export const Control = () => <button>Toggle</button>;",
      filename: featureFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      name: "rejects a raw control inside the retired app ui directory",
      code: "export const Control = () => <button>Toggle</button>;",
      filename: `${appRoot}/src/components/ui/example.tsx`,
      errors: [{ messageId: "restricted" }],
    },
    {
      name: "rejects a raw control in a navigation primitive",
      code: "export const Control = () => <button>Toggle</button>;",
      filename: `${appRoot}/src/components/primitives/platform-icon.tsx`,
      errors: [{ messageId: "restricted" }],
    },
    {
      name: "rejects a motion-wrapped raw control (motion.button bypass)",
      code: "export const Control = () => <motion.button animate={{ opacity: 1 }} />;",
      filename: featureFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      name: "rejects a styled-wrapped raw control (styled.input bypass)",
      code: "export const Control = () => <styled.input />;",
      filename: featureFile,
      errors: [{ messageId: "restricted" }],
    },
    {
      name: "rejects raw select and textarea variants",
      code: "export const Control = () => <><select /><textarea /></>;",
      filename: featureFile,
      errors: [{ messageId: "restricted" }, { messageId: "restricted" }],
    },
  ],
});

ruleTester.run("boundaries/no-canonical-ui-clones", cloneGuardRule, {
  // File-level guardrails keyed to the linted path rather than its imports:
  // the retired app component dirs cannot grow new primitives, flat-namespace
  // stems cannot collide inside the shared library, and no other frontend
  // file may claim a canonical component basename.
  valid: [
    {
      name: "allows a uniquely-named feature component",
      code: "export const Example = () => null;",
      filename: featureFile,
    },
    {
      name: "allows a sanctioned app primitive",
      code: "export const PlatformIcon = () => null;",
      filename: `${appRoot}/src/components/primitives/platform-icon.tsx`,
    },
    {
      name: "allows the canonical shared component itself",
      code: "export const Button = () => null;",
      filename: resolve(appRoot, "../shared/src/components/ui/button.tsx"),
    },
    {
      name: "allows a uniquely-named shared atom",
      code: "export const Atom = () => null;",
      filename: sharedAtomsFile,
    },
    {
      name: "allows canonical-named test files",
      code: "export const t = () => null;",
      filename: `${appRoot}/src/components/ui/button.test.tsx`,
    },
  ],
  invalid: [
    {
      name: "rejects a new file in the retired app ui dir",
      code: "export const Button = () => null;",
      filename: `${appRoot}/src/components/ui/button.tsx`,
      errors: [{ messageId: "retiredDir" }],
    },
    {
      name: "rejects any file in the retired app atoms dir",
      code: "export const Pill = () => null;",
      filename: `${appRoot}/src/components/atoms/status-pill.tsx`,
      errors: [{ messageId: "retiredDir" }],
    },
    {
      name: "rejects a new file in the retired app primitives dir",
      code: "export const Highlight = () => null;",
      filename: `${appRoot}/src/components/primitives/sliding-highlight.tsx`,
      errors: [{ messageId: "retiredDir" }],
    },
    {
      name: "rejects a canonical-basename clone in a feature directory",
      code: "export const Button = () => null;",
      filename: `${appRoot}/src/components/posts/button.tsx`,
      errors: [{ messageId: "nameClone" }],
    },
    {
      name: "rejects a PascalCase clone of a kebab canonical name",
      code: "export const StatusPill = () => null;",
      filename: `${appRoot}/src/components/posts/StatusPill.tsx`,
      errors: [{ messageId: "nameClone" }],
    },
    {
      name: "rejects a flat-namespace collision inside the shared library",
      code: "export const Button = () => null;",
      filename: resolve(appRoot, "../shared/src/components/atoms/button.tsx"),
      errors: [{ messageId: "flatCollision" }],
    },
    {
      name: "rejects a clone on the landing surface",
      code: "export const BrandMark = () => null;",
      filename: resolve(appRoot, "../landing/src/components/BrandMark.tsx"),
      errors: [{ messageId: "nameClone" }],
    },
  ],
});

/**
 * Drives the `.astro` contract checker (lint/astro-ui-contract.mjs) — the only
 * enforcement on landing/docs markup since vp lint cannot parse Astro files.
 * Synthetic filenames under `frontend/` exercise the same path classification
 * the CLI applies to the real tree.
 */
describe("astro UI contract", () => {
  const repoRoot = resolve(appRoot, "../..");
  const astroSrc = (frontmatter: string): string => `---\n${frontmatter}\n---\n<div />`;
  const astroCodes = (frontmatter: string, file?: string): string[] =>
    checkAstroSource(
      astroSrc(frontmatter),
      file ?? `${repoRoot}/frontend/public/src/pages/example.astro`,
    ).map((v) => v.code);

  it("accepts canonical specifiers and same-workspace relative imports", () => {
    expect(
      astroCodes(
        'import BrandMark from "@meltiply/ui/public/brand-mark";\n' +
          'import { toast } from "@meltiply/ui/toast";\n' +
          'import Icon from "./Icon.astro";',
      ),
    ).toEqual([]);
  });

  it.each<[string, string]>([
    ['import { B } from "@/components/ui/button";', "obsoleteSpecifier"],
    ['import { B } from "../../../app/src/components/ui/button";', "obsoleteSpecifier"],
    ['import { R } from "@radix-ui/react-dialog";', "radixBypass"],
    ['import { B } from "@meltiply/ui/src/components/ui/button";', "deepSpecifier"],
    ['import { B } from "../../../shared/src/components/ui/button";', "bypassSpecifier"],
    ['import L from "../../../docs/src/components/layout.astro";', "crossWorkspace"],
    ['import B from "./BrandMark.astro";', "cloneImport"],
  ])("flags %s as %s", (frontmatter, code) => {
    expect(astroCodes(frontmatter)).toContain(code);
  });

  it("flags a local file claiming a canonical basename", () => {
    expect(astroCodes("", `${repoRoot}/frontend/public/src/components/BrandMark.astro`)).toContain(
      "nameClone",
    );
  });

  it("reports no violations across the real .astro tree", () => {
    const files: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (
          e.isDirectory() &&
          e.name !== "node_modules" &&
          e.name !== "dist" &&
          !e.name.startsWith(".")
        )
          walk(p);
        else if (e.name.endsWith(".astro")) files.push(p);
      }
    };
    for (const d of ["frontend/public/src", "frontend/shared"]) {
      walk(join(repoRoot, d));
    }
    const violations = files.flatMap((f) => checkAstroSource(readFileSync(f, "utf8"), f));
    expect(violations.map((v) => `${v.file}:${v.line} ${v.code}`)).toEqual([]);
  });
});
