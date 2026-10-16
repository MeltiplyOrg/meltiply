const svgNamespace = "http://www.w3.org/2000/svg";
const sampleCount = 48;
const angleStep = (Math.PI * 2) / sampleCount;
const frequencies = [3, 6, 11, 17] as const;
const weights = [0.47, 0.3, 0.16, 0.07] as const;
const phaseOffsets = [0.2, 1.4, 2.6, 0.7] as const;
const phaseSpeeds = [0.8, -1.1, 1.4, -0.9] as const;
const stride = 2 + frequencies.length * 2;

/** Caches angular bases once; each painted frame needs only four phase sine/cosine pairs. */
const angularBases = (() => {
  const bases = new Float64Array(sampleCount * stride);
  for (let index = 0; index < sampleCount; index += 1) {
    const angle = index * angleStep;
    const offset = index * stride;
    bases[offset] = Math.cos(angle);
    bases[offset + 1] = Math.sin(angle);
    for (let wave = 0; wave < frequencies.length; wave += 1) {
      bases[offset + 2 + wave * 2] = Math.sin(angle * frequencies[wave]!);
      bases[offset + 3 + wave * 2] = Math.cos(angle * frequencies[wave]!);
    }
  }
  return bases;
})();

/** One owned SVG resource; callers mount its element and use its CSS mask reference. */
export interface ThemeInkMask {
  readonly element: SVGSVGElement;
  readonly reference: string;
  /** Paints a finite nonnegative radius and viewport-space origin, all in CSS pixels. */
  paint(radius: number, originX: number, originY: number): void;
}

/**
 * Creates a live, filled SVG mask with connected lobes and finer turbulent ripples.
 * Radius controls both travel and morphology, so reversing retraces exactly the
 * same outline; scrolling only translates it. Outward-only displacement keeps
 * the nominal disc covered. Cached arrays and a retained path avoid image decoding,
 * filter rasterization, per-frame DOM creation and angular trig recomputation.
 * `inverse` exposes the viewport outside the round drop. Its lower ripples
 * are stronger on withdrawal without stretching the silhouette; even-odd
 * alpha coverage preserves a sharp edge and exact interrupted retracing.
 */
export function createThemeInkMask(inverse: boolean): ThemeInkMask {
  const element = document.createElementNS(svgNamespace, "svg");
  element.setAttribute("width", "0");
  element.setAttribute("height", "0");
  element.setAttribute("aria-hidden", "true");
  element.setAttribute("focusable", "false");
  element.style.cssText = "position:absolute;width:0;height:0;overflow:hidden;";
  const defs = document.createElementNS(svgNamespace, "defs");
  const mask = document.createElementNS(svgNamespace, "mask");
  const id = `theme-ink-mask-${crypto.getRandomValues(new Uint32Array(2)).join("-")}`;
  mask.id = id;
  mask.setAttribute("maskUnits", "userSpaceOnUse");
  mask.setAttribute("maskContentUnits", "userSpaceOnUse");
  mask.setAttribute("x", "0");
  mask.setAttribute("y", "0");
  mask.style.maskType = "alpha";
  const path = document.createElementNS(svgNamespace, "path");
  path.style.fill = "white";
  path.style.fillRule = inverse ? "evenodd" : "nonzero";
  mask.append(path);
  defs.append(mask);
  element.append(defs);
  const knots = new Float64Array(sampleCount * 4);
  const phaseSines = new Float64Array(frequencies.length);
  const phaseCosines = new Float64Array(frequencies.length);
  let lastRadius = Number.NaN;
  let lastX = Number.NaN;
  let lastY = Number.NaN;
  let lastWidth = 0;
  let lastHeight = 0;
  let contour = "";

  /** Countertranslates the inverse viewport rectangle so scrolling moves only the ink silhouette. */
  function writePath(): void {
    const viewport = inverse
      ? `M ${-lastX} ${-lastY} H ${lastWidth - lastX} V ${lastHeight - lastY} H ${-lastX} Z `
      : "";
    path.setAttribute("d", viewport + contour);
  }

  /** Reuses scroll-only contours; circular withdrawal keeps stronger lower turbulence at any viewport size. */
  function paint(radius: number, originX: number, originY: number): void {
    const sizeChanged = innerWidth !== lastWidth || innerHeight !== lastHeight;
    const originChanged = originX !== lastX || originY !== lastY;
    if (sizeChanged) {
      lastWidth = innerWidth;
      lastHeight = innerHeight;
      mask.setAttribute("width", String(lastWidth));
      mask.setAttribute("height", String(lastHeight));
    }
    if (originChanged) {
      lastX = originX;
      lastY = originY;
      path.setAttribute("transform", `translate(${originX} ${originY})`);
    }
    if (radius === lastRadius) {
      if (inverse && (sizeChanged || originChanged)) writePath();
      return;
    }
    lastRadius = radius;
    if (radius === 0) {
      contour = "";
      writePath();
      return;
    }
    const amplitude = Math.min(56, radius * 0.12);
    for (let wave = 0; wave < frequencies.length; wave += 1) {
      const phase = (radius / 680) * phaseSpeeds[wave]! + phaseOffsets[wave]!;
      phaseSines[wave] = Math.sin(phase);
      phaseCosines[wave] = Math.cos(phase);
    }
    for (let index = 0; index < sampleCount; index += 1) {
      const offset = index * stride;
      const cosine = angularBases[offset]!;
      const sine = angularBases[offset + 1]!;
      let displacement = 1.1;
      let derivative = 0;
      for (let wave = 0; wave < frequencies.length; wave += 1) {
        const angleSine = angularBases[offset + 2 + wave * 2]!;
        const angleCosine = angularBases[offset + 3 + wave * 2]!;
        displacement +=
          weights[wave]! * (angleSine * phaseCosines[wave]! + angleCosine * phaseSines[wave]!);
        derivative +=
          weights[wave]! *
          frequencies[wave]! *
          (angleCosine * phaseCosines[wave]! - angleSine * phaseSines[wave]!);
      }
      const lower = inverse ? Math.max(0, sine) : 0;
      const gain = 1 + lower * lower;
      const gainSlope = lower > 0 ? 2 * sine * cosine : 0;
      const distance = radius + amplitude * displacement * gain;
      const slope = amplitude * (derivative * gain + displacement * gainSlope);
      const knot = index * 4;
      knots[knot] = distance * cosine;
      knots[knot + 1] = distance * sine;
      knots[knot + 2] = slope * cosine - distance * sine;
      knots[knot + 3] = slope * sine + distance * cosine;
    }
    let outline = `M ${knots[0]!.toFixed(2)} ${knots[1]!.toFixed(2)}`;
    const tangentScale = angleStep / 3;
    for (let index = 0; index < sampleCount; index += 1) {
      const start = index * 4;
      const end = ((index + 1) % sampleCount) * 4;
      outline += ` C ${(knots[start]! + knots[start + 2]! * tangentScale).toFixed(2)} ${(knots[start + 1]! + knots[start + 3]! * tangentScale).toFixed(2)} ${(knots[end]! - knots[end + 2]! * tangentScale).toFixed(2)} ${(knots[end + 1]! - knots[end + 3]! * tangentScale).toFixed(2)} ${knots[end]!.toFixed(2)} ${knots[end + 1]!.toFixed(2)}`;
    }
    contour = `${outline} Z`;
    writePath();
  }

  return { element, reference: `url("#${id}")`, paint };
}
