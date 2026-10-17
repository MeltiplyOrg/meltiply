import { expect, test, type Locator, type Page } from "@playwright/test";

import {
  allowFunctionalConsent,
  ownerCredentials,
  openOwnerWorkspace,
  waitForWorkspace,
} from "./workspace-session";

test.use({ screenshot: "off", trace: "off" });

/** Each journey opts into functional preferences before app boot. */
test.beforeEach(async ({ page }) => {
  await allowFunctionalConsent(page);
});

test.setTimeout(90_000);

/** localStorage key the app writes the selected theme under (`themeStorageKey`). */
const THEME_STORAGE_KEY = "meltiply.theme";
/** localStorage key for the manual low-motion choice (`motionPreferenceStorageKey`). */
const LOW_MOTION_STORAGE_KEY = "meltiply.low-motion";

/**
 * Contract durations, asserted as consumer-visible timing bounds rather than
 * internals: the ink wave spreads over 1200ms and the reduced-motion blink
 * commits near its 100ms midpoint inside a 200ms dip.
 */
const FULL_WAVE_MS = 1200;
/** Lower bound for a real wave; a ~200ms blink or instant swap fails this. */
const WAVE_MIN_MS = 900;
/** Upper bound; a wave that leaks past this is runaway or restarted work. */
const WAVE_MAX_MS = 4_000;

/** One painted element sampled across the wave by the in-page recorder. */
interface WaveProbeResult {
  /** Document-space distance from the activation point at arm time (px). */
  distance: number;
  /** Times (performance.now ms) the element's paint signature changed. */
  changes: number[];
  /** Distinct paint signatures ever observed on the element. */
  distinctSignatures: number;
  /** Whether the element was still in the document when the recorder stopped. */
  connected: boolean;
  /** Whether the post-stop signature equals the pre-wave signature again. */
  revertedToSource: boolean | null;
}

/** Serialized snapshot returned by the in-page recorder's `stop()`. */
interface WaveRecording {
  /** performance.now() when the recorder armed; all other times share this clock. */
  armT: number;
  /** Each interval where `data-theme-ink` was present on the root. */
  inkIntervals: { start: number; end: number | null }[];
  /** Every `dark` class transition on the root, in order. */
  darkChanges: { t: number; dark: boolean }[];
  /** Every `data-theme-wave` value the root carried, in order. */
  waveAttrChanges: { t: number; value: string | null }[];
  /** Root WAAPI animations observed (drives the reduced-motion blink). */
  rootAnimations: { t: number; duration: number | string | null; props: string[] }[];
  /** Lowest sampled computed root opacity (blink dip detection). */
  minOpacity: number;
  /** Distinct masked-copy overlays ever mounted (one per wave). */
  layerMounts: number;
  /** Most overlays coexisting at once; retargets must share a single copy. */
  maxConcurrentLayers: number;
  /** Frames where a live probe read `color: transparent` (feather regression). */
  transparentTextFrames: number;
  probes: WaveProbeResult[];
  /** True when body's children after stop are the exact same nodes, same order. */
  bodyIdentityIntact: boolean;
  /** True when every body child present at arm time is still in the body. */
  allInitialChildrenInBody: boolean;
}

/** Test-only recorder surface installed on `window` by {@link armWaveRecorder}. */
interface InstrumentedWindow extends Window {
  __meltiplyWaveRecorder?: {
    probes: { changes: number[] }[];
    stop(): WaveRecording;
  };
}

/** Resolves the sidebar footer's theme toggle by its action label. */
function sidebarThemeToggle(page: Page): Locator {
  return page.getByRole("button", { name: /switch to (dark|light) mode/i });
}

/** Resolves one segment of the DevBox theme control (values render lowercase). */
function themeTab(page: Page, name: "light" | "dark"): Locator {
  return page
    .locator('[data-devbox] [role="tab"]')
    .filter({ hasText: new RegExp(`^${name}$`, "i") });
}

/** Expands the DevBox dock and opens the Skeletons tab holding the theme row. */
async function openDevBox(page: Page): Promise<void> {
  const expand = page.getByRole("button", { name: "Expand DevBox" });
  await expect(expand).toBeVisible({ timeout: 15_000 });
  await expand.click();
  await expect(page.getByRole("region", { name: "Meltiply DevBox" })).toBeVisible();
  const skeletons = page.getByRole("tab", { name: "Skeletons", exact: true });
  if ((await skeletons.getAttribute("aria-selected")) !== "true") {
    await skeletons.click();
  }
  await expect(themeTab(page, "dark")).toBeVisible();
}

/** Reads the theme the app has actually committed (`dark` on the root). */
async function readAppliedTheme(page: Page): Promise<"light" | "dark"> {
  const dark = await page.evaluate(() => document.documentElement.classList.contains("dark"));
  return dark ? "dark" : "light";
}

/** Reads the persisted theme preference from `localStorage`. */
async function readStoredTheme(page: Page): Promise<string | null> {
  return page.evaluate((key) => window.localStorage.getItem(key), THEME_STORAGE_KEY);
}

/**
 * Records resolved palette colors on real surfaces by document-space distance,
 * plus root commits, opacity, animation timing, masked-overlay lifecycle and
 * element identity. Live surfaces may repaint exactly once — at the commit —
 * and only ever show the source or the target palette; the masked copy does
 * all mid-flight painting, so intermediate colors or early repaints are the
 * feather/blend and live-token regressions respectively.
 */
async function armWaveRecorder(
  page: Page,
  origin: { x: number; y: number },
  probeLimit = 24,
): Promise<void> {
  await page.evaluate(
    ({ originX, originY, probeLimit }) => {
      const root = document.documentElement;
      const signature = (el: Element): string => {
        const cs = getComputedStyle(el);
        return `${cs.getPropertyValue("--surface")}|${cs.getPropertyValue("--ink")}|${cs.getPropertyValue("--line")}|${cs.backgroundColor}|${cs.color}`;
      };
      const layerCount = (): number =>
        [...root.children].filter((el) => el.hasAttribute("data-theme-ink-layer")).length;
      const initialBodyChildren = [...document.body.children];
      const rec = {
        armT: performance.now(),
        inkIntervals: [] as { start: number; end: number | null }[],
        openInkStart: null as number | null,
        darkChanges: [] as { t: number; dark: boolean }[],
        waveAttrChanges: [] as { t: number; value: string | null }[],
        rootAnimations: [] as {
          t: number;
          duration: number | string | null;
          props: string[];
        }[],
        minOpacity: 1,
        layerMounts: 0,
        maxConcurrentLayers: 0,
        transparentTextFrames: 0,
        stopped: false,
        probes: [] as {
          el: Element;
          distance: number;
          signature: string;
          lastSig: string;
          seen: Set<string>;
          changes: number[];
        }[],
        /** Stops observers/sampling and closes the active interval, returning serializable evidence without DOM nodes. */
        stop() {
          this.stopped = true;
          observer.disconnect();
          layerObserver.disconnect();
          if (this.openInkStart !== null) {
            this.inkIntervals[this.inkIntervals.length - 1]!.end = performance.now();
            this.openInkStart = null;
          }
          return {
            armT: this.armT,
            inkIntervals: this.inkIntervals,
            darkChanges: this.darkChanges,
            waveAttrChanges: this.waveAttrChanges,
            rootAnimations: this.rootAnimations,
            minOpacity: this.minOpacity,
            layerMounts: this.layerMounts,
            maxConcurrentLayers: this.maxConcurrentLayers,
            transparentTextFrames: this.transparentTextFrames,
            probes: this.probes.map((probe) => ({
              distance: probe.distance,
              changes: probe.changes,
              distinctSignatures: probe.seen.size,
              connected: probe.el.isConnected,
              revertedToSource: probe.el.isConnected
                ? signature(probe.el) === probe.signature
                : null,
            })),
            bodyIdentityIntact: initialBodyChildren.every(
              (el, index) => document.body.children[index] === el,
            ),
            allInitialChildrenInBody: initialBodyChildren.every(
              (el) => el.parentNode === document.body,
            ),
          };
        },
      };

      // Painted probes only: a visible palette must land on real surfaces,
      // and DevBox chrome is excluded so collapsing it mid-wave adds no noise.
      const candidates: { el: Element; d: number; sig: string }[] = [];
      for (const el of document.body.querySelectorAll("*")) {
        if (el.closest("[data-devbox]")) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) continue;
        const cs = getComputedStyle(el);
        if (cs.backgroundColor === "rgba(0, 0, 0, 0)" && !cs.backgroundImage.includes("gradient")) {
          continue;
        }
        const docX = rect.left + rect.width / 2 + window.scrollX;
        const docY = rect.top + rect.height / 2 + window.scrollY;
        candidates.push({
          el,
          d: Math.hypot(docX - originX, docY - originY),
          sig: signature(el),
        });
      }
      candidates.sort((a, b) => a.d - b.d);
      const stride = Math.max(1, Math.floor(candidates.length / probeLimit));
      for (
        let index = 0;
        index < candidates.length && rec.probes.length < probeLimit;
        index += stride
      ) {
        const candidate = candidates[index]!;
        rec.probes.push({
          el: candidate.el,
          distance: Math.round(candidate.d),
          signature: candidate.sig,
          lastSig: candidate.sig,
          seen: new Set([candidate.sig]),
          changes: [],
        });
      }

      // Baseline palette state at arm; darkChanges records TRANSITIONS only.
      let lastDarkState = root.classList.contains("dark");
      const recordRootAttributes = (t: number): void => {
        const dark = root.classList.contains("dark");
        if (dark !== lastDarkState) {
          rec.darkChanges.push({ t, dark });
          lastDarkState = dark;
        }
        const ink = root.hasAttribute("data-theme-ink");
        if (ink && rec.openInkStart === null) {
          rec.openInkStart = t;
          rec.inkIntervals.push({ start: t, end: null });
        } else if (!ink && rec.openInkStart !== null) {
          rec.inkIntervals[rec.inkIntervals.length - 1]!.end = t;
          rec.openInkStart = null;
        }
        const wave = root.getAttribute("data-theme-wave");
        const lastWave = rec.waveAttrChanges[rec.waveAttrChanges.length - 1];
        if (!lastWave || lastWave.value !== wave) {
          rec.waveAttrChanges.push({ t, value: wave });
        }
      };

      const observer = new MutationObserver((mutations) => {
        const t = performance.now();
        for (const mutation of mutations) {
          if (mutation.target === root) recordRootAttributes(t);
        }
      });
      observer.observe(root, { attributes: true });

      // The masked copy mounts beside the body, so count mounts/coexistence
      // by watching the root element's direct children rather than the subtree.
      const layerObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          for (const node of mutation.addedNodes) {
            if (node instanceof Element && node.hasAttribute("data-theme-ink-layer")) {
              rec.layerMounts += 1;
            }
          }
        }
        rec.maxConcurrentLayers = Math.max(rec.maxConcurrentLayers, layerCount());
      });
      layerObserver.observe(root, { childList: true });

      const seenAnimations = new Set<Animation>();
      const loop = (): void => {
        if (rec.stopped) return;
        const t = performance.now();
        rec.minOpacity = Math.min(rec.minOpacity, parseFloat(getComputedStyle(root).opacity));
        rec.maxConcurrentLayers = Math.max(rec.maxConcurrentLayers, layerCount());
        let transparent = false;
        for (const probe of rec.probes) {
          if (!probe.el.isConnected) continue;
          const sig = signature(probe.el);
          probe.seen.add(sig);
          if (sig !== probe.lastSig) {
            probe.lastSig = sig;
            probe.changes.push(t);
          }
          if (getComputedStyle(probe.el).color === "rgba(0, 0, 0, 0)") {
            transparent = true;
          }
        }
        if (transparent) rec.transparentTextFrames += 1;
        for (const animation of document.getAnimations()) {
          const effect = animation.effect;
          if (
            !(effect instanceof KeyframeEffect) ||
            effect.target !== root ||
            seenAnimations.has(animation)
          ) {
            continue;
          }
          seenAnimations.add(animation);
          const props = effect
            .getKeyframes()
            .flatMap((frame) => Object.keys(frame))
            .filter((key) => key !== "offset" && key !== "easing" && key !== "composite");
          const duration = effect.getComputedTiming().duration;
          rec.rootAnimations.push({
            t,
            duration:
              typeof duration === "number" || typeof duration === "string" ? duration : null,
            props,
          });
        }
        requestAnimationFrame(loop);
      };
      requestAnimationFrame(loop);

      (window as InstrumentedWindow).__meltiplyWaveRecorder = rec;
    },
    { originX: origin.x, originY: origin.y, probeLimit },
  );
}

/** Stops the recorder and returns the serialized wave observation. */
async function readWaveRecording(page: Page): Promise<WaveRecording> {
  return page.evaluate(() => {
    const recorder = (window as InstrumentedWindow).__meltiplyWaveRecorder;
    if (!recorder) throw new Error("wave recorder was never armed");
    return recorder.stop();
  });
}

/** Count of recorder probes that have repainted so far. */
async function repaintedProbeCount(page: Page): Promise<number> {
  return page.evaluate(
    () =>
      (window as InstrumentedWindow).__meltiplyWaveRecorder?.probes.filter(
        (probe) => probe.changes.length > 0,
      ).length ?? 0,
  );
}

/** Current document-space mask radius in px, or 0 when no wave is mounted. */
async function waveRadiusPx(page: Page): Promise<number> {
  return page.evaluate(
    () => parseFloat(document.documentElement.dataset.themeWaveRadius ?? "0") || 0,
  );
}

/** Waits for the wave marker to clear, bounding a runaway wave. */
async function waitForWaveSettled(page: Page): Promise<void> {
  await expect
    .poll(() => page.evaluate(() => !document.documentElement.hasAttribute("data-theme-ink")), {
      timeout: 15_000,
    })
    .toBe(true);
}

/** Returns the single dark-class commit, asserting there was exactly one. */
function singleDarkCommit(recording: WaveRecording): { t: number; dark: boolean } {
  const darkCommits = recording.darkChanges.filter((change) => change.dark);
  expect(darkCommits).toHaveLength(1);
  return darkCommits[0]!;
}

test.describe("masked theme wave", () => {
  /**
   * The wave reveals one inert full-document copy painted in the target
   * palette through a growing document-space mask over the contracted 1200ms:
   * live surfaces keep the source palette until the endpoint `.dark` commit,
   * the UI stays interactive and unduplicated mid-wave, and cleanup returns
   * the very same live elements — no leftover layer, flags or inline paint.
   */
  test("reveals a masked copy over live DOM and cleans up at the endpoint", async ({ page }) => {
    await page.goto("/sign-in");
    await openDevBox(page);
    const darkTab = themeTab(page, "dark");
    const box = await darkTab.boundingBox();
    if (!box) throw new Error("devbox dark tab has no bounding box");
    const origin = { x: box.x + box.width / 2, y: box.y + box.height / 2 };

    await armWaveRecorder(page, origin);
    await darkTab.click();

    // Exactly one inert copy, mounted beside (never inside) the live body,
    // so assistive tech and role queries still see a single control set.
    await expect(page.locator("html")).toHaveAttribute("data-theme-ink", "");
    const layer = page.locator("html > [data-theme-ink-layer]");
    await expect(layer).toHaveCount(1);
    await expect(layer).toHaveAttribute("data-theme-ink-layer", "dark");
    await expect(layer).toHaveAttribute("aria-hidden", "true");
    await expect(layer).toHaveAttribute("inert", "");
    await expect(page.getByRole("button", { name: "Collapse DevBox" })).toHaveCount(1);

    // Live surfaces must NOT repaint while the mask does the revealing —
    // mid-flight probe repaints are the old per-element token regression.
    expect(await repaintedProbeCount(page)).toBe(0);

    // The interface stays usable underneath the overlay: collapsing DevBox
    // mid-wave is a real interaction, not a screenshot.
    await page.getByRole("button", { name: "Collapse DevBox" }).click();
    await expect(page.getByRole("button", { name: "Expand DevBox" })).toBeVisible();

    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("dark");
    expect(await readStoredTheme(page)).toBe("dark");

    const recording = await readWaveRecording(page);
    expect(recording.inkIntervals).toHaveLength(1);
    const wave = recording.inkIntervals[0]!;
    expect(wave.end).not.toBeNull();
    const duration = wave.end! - wave.start;
    // The 1200ms spread is the contract: an instant swap or a ~200ms blink is
    // a regression, and so is a wave that restarts and runs long.
    expect(duration).toBeGreaterThanOrEqual(WAVE_MIN_MS);
    expect(duration).toBeLessThan(WAVE_MAX_MS);

    // The wave marker names the original target for the whole flight.
    expect(recording.waveAttrChanges[0]?.value).toBe("dark");

    // The committed palette lands once, at the endpoint — never early.
    const commit = singleDarkCommit(recording);
    expect(commit.t - wave.start).toBeGreaterThan(FULL_WAVE_MS * 0.5);
    expect(Math.abs(commit.t - wave.end!)).toBeLessThan(600);

    // Live probes repaint at most once — source → target at the commit —
    // and only ever show one of the two real palettes (no blend, no feather).
    const repainted = recording.probes.filter((probe) => probe.connected);
    expect(repainted.length).toBeGreaterThanOrEqual(4);
    for (const probe of repainted) {
      expect(probe.changes.length).toBeLessThanOrEqual(1);
      expect(probe.distinctSignatures).toBeLessThanOrEqual(2);
      if (probe.changes.length === 1) {
        expect(Math.abs(probe.changes[0]! - commit.t)).toBeLessThan(600);
      }
    }
    expect(recording.transparentTextFrames).toBe(0);
    // One overlay total across the whole activation — never stacked copies.
    expect(recording.maxConcurrentLayers).toBe(1);

    // Endpoint cleanup: the very same body children, the copy removed, no
    // leftover wave flags or inline paint residue on the root.
    expect(recording.bodyIdentityIntact).toBe(true);
    await expect(layer).toHaveCount(0);
    await expect(page.locator("html")).not.toHaveAttribute("data-theme-wave");
    await expect(page.locator("html")).not.toHaveClass(/theme-changing/);
    expect(await page.evaluate(() => document.documentElement.getAttribute("style") ?? "")).toBe(
      "",
    );
  });

  /**
   * A second activation selecting the committed palette must roll the SAME
   * wave back: `data-theme-ink` never lifts, the single overlay shrinks its
   * mask instead of being replaced, the root palette never commits, and the
   * retreat takes roughly the time the advance took (a cancel-and-restart
   * always needs a fresh 1200ms) — the same live elements, untouched.
   */
  test("rolls the running wave back when the second activation picks the source theme", async ({
    page,
  }) => {
    await page.goto("/sign-in");
    await openDevBox(page);
    const darkTab = themeTab(page, "dark");
    const lightTab = themeTab(page, "light");
    const box = await darkTab.boundingBox();
    if (!box) throw new Error("devbox dark tab has no bounding box");
    await armWaveRecorder(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

    await darkTab.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-ink", "");
    // Let the mask visibly spread so the reverse has coverage to roll back.
    await expect.poll(() => waveRadiusPx(page)).toBeGreaterThan(50);
    const peakRadius = await waveRadiusPx(page);
    await lightTab.click();
    const retargetAt = await page.evaluate(() => performance.now());
    // The retreat is real mask movement, not an instant collapse.
    await expect.poll(() => waveRadiusPx(page)).toBeLessThan(peakRadius);

    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("light");
    expect(await readStoredTheme(page)).toBe("light");

    const recording = await readWaveRecording(page);
    // One continuous wave — retargeting lifts neither the marker nor the layer.
    expect(recording.inkIntervals).toHaveLength(1);
    const wave = recording.inkIntervals[0]!;
    expect(wave.end).not.toBeNull();
    expect(recording.waveAttrChanges.map((change) => change.value)).toEqual(["dark", null]);
    expect(recording.maxConcurrentLayers).toBe(1);
    expect(recording.layerMounts).toBe(1);

    // The decisive palette regression: `.dark` must never have committed —
    // a jumpy implementation applies it at the flip or at an early endpoint.
    expect(recording.darkChanges.every((change) => !change.dark)).toBe(true);

    // Continuity: the retreat settles near 2× the time spent advancing. A
    // restart needs a fresh ~1200ms after the retarget and overshoots this.
    const advanceMs = retargetAt - wave.start;
    const elapsed = wave.end! - wave.start;
    expect(elapsed).toBeGreaterThan(advanceMs);
    expect(elapsed).toBeLessThan(2 * advanceMs + 600);
    expect(elapsed).toBeLessThan(WAVE_MAX_MS);

    // Live surfaces never repainted at all: the mask owned every pixel change
    // and the elements settle back on the source palette they never left.
    const touched = recording.probes.filter((probe) => probe.connected);
    expect(touched.length).toBeGreaterThan(0);
    for (const probe of touched) {
      expect(probe.changes).toHaveLength(0);
      expect(probe.revertedToSource).toBe(true);
    }
    expect(recording.bodyIdentityIntact).toBe(true);
    await expect(page.locator("html > [data-theme-ink-layer]")).toHaveCount(0);
  });

  /**
   * Re-selecting the wave's target while it is rolling back must continue
   * forward from current progress — no new capture and no radius reset. The
   * discriminating evidence is continuity (one uninterrupted marker interval,
   * one overlay mount, one endpoint commit): a cancel-and-restart lifts
   * `data-theme-ink` into a second interval and mounts a second copy.
   */
  test("continues the same wave forward when the target is re-selected", async ({ page }) => {
    await page.goto("/sign-in");
    await openDevBox(page);
    const darkTab = themeTab(page, "dark");
    const lightTab = themeTab(page, "light");
    const box = await darkTab.boundingBox();
    if (!box) throw new Error("devbox dark tab has no bounding box");
    await armWaveRecorder(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

    await darkTab.click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-ink", "");
    await expect.poll(() => waveRadiusPx(page)).toBeGreaterThan(50);
    await lightTab.click();
    // Give the retreat real runway: an immediate re-forward is covered by the
    // same-task spam test; here the mask must visibly roll back first.
    await page.waitForTimeout(200);
    await darkTab.click();
    const retargetAt = await page.evaluate(() => performance.now());

    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("dark");
    expect(await readStoredTheme(page)).toBe("dark");

    const recording = await readWaveRecording(page);
    expect(recording.inkIntervals).toHaveLength(1);
    const wave = recording.inkIntervals[0]!;
    expect(wave.end).not.toBeNull();
    expect(recording.maxConcurrentLayers).toBe(1);
    expect(recording.layerMounts).toBe(1);
    const commit = singleDarkCommit(recording);
    // The single commit lands after the retarget, well under a restart's
    // full 1200ms tail plus the time already spent advancing.
    expect(commit.t).toBeGreaterThan(retargetAt);
    expect(commit.t).toBeLessThan(retargetAt + FULL_WAVE_MS + 500);
    expect(recording.waveAttrChanges.map((change) => change.value)).toEqual(["dark", null]);
    // Live probes repaint once, at the single endpoint commit.
    for (const probe of recording.probes) {
      expect(probe.changes.length).toBeLessThanOrEqual(1);
    }
    expect(recording.bodyIdentityIntact).toBe(true);
  });

  /**
   * Same-task activation spam — clicks landing before the wave's first
   * frame — must still honor parity through `requestedTheme`: an odd burst
   * ends on the clicked target exactly once at the endpoint, an even burst
   * rolls back to the committed palette, and the root never flickers through
   * intermediate commits.
   */
  test("honors parity for activation bursts that land before the first frame", async ({ page }) => {
    await page.goto("/sign-in");
    await openDevBox(page);
    const box = await themeTab(page, "dark").boundingBox();
    if (!box) throw new Error("devbox theme tab has no bounding box");
    await armWaveRecorder(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

    // Odd burst in one task: dark → light → dark must end dark.
    await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-devbox] [role="tab"]')];
      const pick = (label: string) =>
        tabs.find((tab) => tab.textContent?.trim().toLowerCase() === label);
      for (const label of ["dark", "light", "dark"]) {
        pick(label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });

    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("dark");
    expect(await readStoredTheme(page)).toBe("dark");

    // Even burst in one task: light → dark must roll all the way back to dark.
    await page.evaluate(() => {
      const tabs = [...document.querySelectorAll('[data-devbox] [role="tab"]')];
      const pick = (label: string) =>
        tabs.find((tab) => tab.textContent?.trim().toLowerCase() === label);
      for (const label of ["light", "dark"]) {
        pick(label)?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      }
    });

    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("dark");
    expect(await readStoredTheme(page)).toBe("dark");

    const recording = await readWaveRecording(page);
    // Two waves total (one per burst), zero direction restarts within them.
    expect(recording.inkIntervals).toHaveLength(2);
    // The palette committed exactly once: burst one's endpoint. Burst two
    // reversed home and never touched the root class at all.
    const commit = singleDarkCommit(recording);
    const firstWave = recording.inkIntervals[0]!;
    expect(commit.t - firstWave.start).toBeGreaterThan(FULL_WAVE_MS * 0.5);
    expect(recording.darkChanges.filter((change) => !change.dark)).toHaveLength(0);
    expect(recording.maxConcurrentLayers).toBe(1);
    expect(recording.bodyIdentityIntact).toBe(true);
  });

  /**
   * The masked copy is a live mirror, not a snapshot: cloned content sits at
   * identical viewport geometry through window and nested scrolling, carries
   * the target palette while live surfaces keep the source palette, and
   * includes below-the-fold nodes a viewport-sized capture could never hold.
   */
  test("keeps the masked copy aligned through document and nested scroll", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.goto("/sign-in");
    await openDevBox(page);

    // Test surfaces appended inside the live document — one scrolled to
    // mid-wave, one inside a nested scroller, one that stays below the fold.
    // `data-wave-scroll` marks them so the clone lookup survives id-stripping.
    const docTops = await page.evaluate(() => {
      const make = (marker: string, marginTop: number) => {
        const el = document.createElement("div");
        el.setAttribute("data-wave-scroll", marker);
        el.style.cssText = `height:60px;margin-top:${marginTop}px;background:var(--surface);border:1px solid var(--line)`;
        el.textContent = "wave scroll probe";
        document.body.appendChild(el);
        return el;
      };
      const scroller = make("scroller", 120);
      scroller.style.height = "120px";
      scroller.style.overflow = "auto";
      const tall = document.createElement("div");
      tall.style.height = "400px";
      tall.textContent = "nested scrollable content";
      scroller.appendChild(tall);
      const sentinel = make("sentinel", 200);
      const deep = make("deep", 400);
      return {
        sentinelTop: sentinel.getBoundingClientRect().top + window.scrollY,
        deepTop: deep.getBoundingClientRect().top + window.scrollY,
      };
    });
    expect(docTops.sentinelTop).toBeGreaterThan(420);
    expect(docTops.deepTop).toBeGreaterThan(docTops.sentinelTop);

    const box = await themeTab(page, "dark").boundingBox();
    if (!box) throw new Error("devbox theme tab has no bounding box");
    await armWaveRecorder(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });
    await themeTab(page, "dark").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme-ink", "");

    // Scroll the sentinel into view and scroll the nested scroller while the
    // wave is mid-flight: the clone must track both, every frame.
    await page.evaluate(() => {
      document.querySelector('[data-wave-scroll="sentinel"]')?.scrollIntoView({ block: "center" });
      const scroller = document.querySelector<HTMLElement>('[data-wave-scroll="scroller"]');
      if (scroller) scroller.scrollTop = 140;
      scroller?.dispatchEvent(new Event("scroll"));
    });
    expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);

    // Geometry + scroll-offset alignment between live nodes and their clones,
    // matched by document order within the marked set (clones rewrite ids but
    // keep every other attribute). The poll returns null until the copy both
    // exists and aligns, so a settling mirror still satisfies the check.
    const readAlignment = () =>
      page.evaluate(() => {
        const live = [...document.body.querySelectorAll("[data-wave-scroll]")];
        const layer = document.querySelector("[data-theme-ink-layer]");
        if (!layer) return null;
        const clones = [...layer.querySelectorAll("[data-wave-scroll]")];
        if (clones.length !== live.length) return null;
        let worst = 0;
        for (let index = 0; index < live.length; index += 1) {
          const a = live[index]!.getBoundingClientRect();
          const b = clones[index]!.getBoundingClientRect();
          worst = Math.max(
            worst,
            Math.abs(a.left - b.left),
            Math.abs(a.top - b.top),
            Math.abs(a.width - b.width),
          );
        }
        const byMarker = (list: Element[], marker: string) =>
          list.find((el) => el.getAttribute("data-wave-scroll") === marker);
        return {
          worst,
          liveCount: live.length,
          cloneScrollTop: byMarker(clones, "scroller")?.scrollTop ?? -1,
          liveScrollTop: byMarker(live, "scroller")?.scrollTop ?? -1,
        };
      });
    await expect.poll(readAlignment).toEqual({
      worst: expect.any(Number),
      liveCount: 3,
      cloneScrollTop: 140,
      liveScrollTop: 140,
    });
    const alignment = await readAlignment();
    expect(alignment!.worst).toBeLessThan(1.5);
    // Mid-flight paint: live surfaces keep the committed source palette while
    // their clones already show the target — capture both for the endpoint
    // comparison after settle (the clone is gone by then).
    const paint = await page.evaluate(() => {
      const paintOf = (el: Element | null | undefined) => {
        if (!el) return null;
        const cs = getComputedStyle(el);
        return `${cs.backgroundColor}|${cs.color}`;
      };
      const live = document.querySelector('[data-wave-scroll="sentinel"]');
      const clone = document.querySelector('[data-theme-ink-layer] [data-wave-scroll="sentinel"]');
      return { live: paintOf(live), clone: paintOf(clone) };
    });
    expect(paint.live).not.toBeNull();
    expect(paint.clone).not.toBeNull();
    expect(paint.clone).not.toBe(paint.live);

    // Content inserted mid-wave appears inside the copy on the mutation
    // mirror pass and lands aligned — the mask never re-reads or resets.
    await page.evaluate(() => {
      const late = document.createElement("div");
      late.setAttribute("data-wave-scroll", "late");
      late.style.cssText = "height:60px;background:var(--surface);border:1px solid var(--line)";
      late.textContent = "late wave content";
      document.body.appendChild(late);
    });
    await expect.poll(readAlignment).toEqual({
      worst: expect.any(Number),
      liveCount: 4,
      cloneScrollTop: 140,
      liveScrollTop: 140,
    });
    expect((await readAlignment())!.worst).toBeLessThan(1.5);

    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("dark");

    // The copy's mid-flight paint is the palette the commit lands on: the
    // scrolled-to sentinel ends on exactly the colors its clone showed.
    const settled = await page.evaluate(
      () =>
        getComputedStyle(document.querySelector('[data-wave-scroll="sentinel"]')!).backgroundColor +
        "|" +
        getComputedStyle(document.querySelector('[data-wave-scroll="sentinel"]')!).color,
    );
    expect(settled).toBe(paint.clone);

    const recording = await readWaveRecording(page);
    expect(recording.inkIntervals).toHaveLength(1);
    expect(recording.layerMounts).toBe(1);
    expect(recording.maxConcurrentLayers).toBe(1);
    // The marked nodes the test appended are still the same live nodes.
    expect(recording.allInitialChildrenInBody).toBe(true);
    await expect(page.locator("html > [data-theme-ink-layer]")).toHaveCount(0);
  });
});

test.describe("reduced motion", () => {
  /**
   * A persisted manual Low-motion choice swaps the spatial wave for a single
   * ~200ms opacity blink on the document root: the palette commits inside the
   * dip, `data-theme-ink` never appears, no masked copy mounts, and the
   * selection still persists.
   */
  test("replaces the wave with a single brief blink under manual low motion", async ({ page }) => {
    await page.addInitScript(
      (key) => window.localStorage.setItem(key, "on"),
      LOW_MOTION_STORAGE_KEY,
    );
    await page.goto("/sign-in");
    await openDevBox(page);
    const box = await themeTab(page, "dark").boundingBox();
    if (!box) throw new Error("devbox theme tab has no bounding box");
    await armWaveRecorder(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

    await themeTab(page, "dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 15_000 });
    expect(await readStoredTheme(page)).toBe("dark");

    const recording = await readWaveRecording(page);
    // No spatial wave at all under reduced motion.
    expect(recording.inkIntervals).toHaveLength(0);
    expect(recording.layerMounts).toBe(0);
    const commit = singleDarkCommit(recording);
    // The palette lands inside the ~200ms blink window, not after a wave.
    expect(commit.t - recording.armT).toBeLessThan(FULL_WAVE_MS);
    // A real opacity dip on the root — not a bare instant swap.
    expect(recording.minOpacity).toBeLessThan(0.999);
    expect(
      recording.rootAnimations.some(
        (animation) =>
          typeof animation.duration === "number" &&
          animation.duration >= 100 &&
          animation.duration <= 400 &&
          animation.props.includes("opacity"),
      ),
    ).toBe(true);
  });

  /**
   * With no manual choice stored, an OS-level `prefers-reduced-motion:
   * reduce` picks the same blink path: the system preference is honored even
   * though the in-app toggle was never touched.
   */
  test("blinks when the OS requests reduced motion", async ({ page }) => {
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/sign-in");
    await openDevBox(page);
    const box = await themeTab(page, "dark").boundingBox();
    if (!box) throw new Error("devbox theme tab has no bounding box");
    await armWaveRecorder(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

    await themeTab(page, "dark").click();
    await expect(page.locator("html")).toHaveClass(/dark/, { timeout: 15_000 });
    await expect(page.locator("html")).toHaveAttribute("data-low-motion", "");

    const recording = await readWaveRecording(page);
    expect(recording.inkIntervals).toHaveLength(0);
    expect(recording.layerMounts).toBe(0);
    expect(recording.minOpacity).toBeLessThan(0.999);
    expect(await readStoredTheme(page)).toBe("dark");
  });
});

test.describe("signed-in shell", () => {
  /**
   * The sidebar toggle is the primary control: it calls `toggleTheme`, whose
   * target flips parity off the requested palette. Two same-task activations
   * must therefore roll the wave home with zero palette commits, and a clean
   * activation afterwards runs one full forward wave ending in exactly one
   * `.dark` commit — on the real authenticated shell, not a harness.
   */
  test("reverses on same-task double toggle and completes a clean forward wave", async ({
    page,
  }) => {
    await page.emulateMedia({ colorScheme: "light" });
    await openOwnerWorkspace(page, ownerCredentials());
    await page.waitForURL(/\/posts(?:\?|$)/, { timeout: 30_000 });
    await waitForWorkspace(page);

    const toggle = sidebarThemeToggle(page);
    const box = await toggle.boundingBox();
    if (!box) throw new Error("sidebar theme toggle has no bounding box");
    await armWaveRecorder(page, { x: box.x + box.width / 2, y: box.y + box.height / 2 });

    // Two toggles inside one task: requested-theme parity must net zero.
    // The toggle's accessible name comes from its `title` attribute.
    await page.evaluate(() => {
      const button = [...document.querySelectorAll("button")].find((el) =>
        /switch to (dark|light) mode/i.test(el.getAttribute("title") ?? ""),
      );
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      button?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("light");
    expect(await readStoredTheme(page)).toBe("light");

    // A clean activation then runs one uninterrupted forward wave.
    await toggle.click();
    await waitForWaveSettled(page);
    expect(await readAppliedTheme(page)).toBe("dark");
    expect(await readStoredTheme(page)).toBe("dark");

    const recording = await readWaveRecording(page);
    // The double toggle produced exactly one `.dark` commit across the whole
    // run — the forward wave's endpoint. The reversed wave never committed.
    singleDarkCommit(recording);
    expect(recording.darkChanges.filter((change) => !change.dark)).toHaveLength(0);
    expect(recording.allInitialChildrenInBody).toBe(true);
    expect(recording.maxConcurrentLayers).toBe(1);
    await expect(page.locator("html > [data-theme-ink-layer]")).toHaveCount(0);
  });
});
