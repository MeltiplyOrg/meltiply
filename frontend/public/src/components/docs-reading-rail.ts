/** A measured heading binds document scroll position to distance along the bent rail. */
interface RailStop {
  top: number;
  distance: number;
  row: number;
}

const owners = new WeakMap<HTMLElement, () => void>();

/**
 * Measures TOC links with numeric parent data-depth and tracks native scrolling.
 * Resize/font changes remeasure geometry; hidden rails wait for resize.
 * beforeHydration preserves exact React style serialization for DOM adoption.
 * Returns observer cleanup; reinitialization releases the previous owner without
 * hiding its painted rail. Missing decoration returns no cleanup.
 */
export function initializeReadingRail(
  root: HTMLElement,
  lowMotion: boolean,
  beforeHydration = false,
) {
  owners.get(root)?.();
  const track = root.querySelector<SVGPathElement>(".docs-reading-remaining");
  const progress = root.querySelector<SVGPathElement>(".docs-reading-progress");
  const plane = root.querySelector<HTMLElement>(".docs-reading-plane");
  if (!track || !progress || !plane) return;
  const links = Array.from(root.querySelectorAll<HTMLAnchorElement>("a"));
  const minDepth = Math.min(...links.map((link) => Number(link.parentElement?.dataset.depth)));
  root.dataset.lowMotion = String(lowMotion);
  const rail = root.closest<HTMLElement>("#nd-toc");
  let stops: RailStop[] = [];
  let length = 0;
  let readingOffset = 0;
  let frame = 0;
  let disposed = false;

  // One coalesced frame writes decoration only; article layout remains untouched.
  const paint = () => {
    frame = 0;
    if (stops.length === 0) return;
    if (rail?.dataset.tocTransition === "closing" || rail?.dataset.tocTransition === "loading")
      return;
    const readingTop = window.scrollY + readingOffset;
    let index = 0;
    while (index + 1 < stops.length && stops[index + 1].top <= readingTop) {
      index += 1;
    }
    const current = stops[index];
    const next = stops[index + 1];
    const fraction = next
      ? Math.max(0, Math.min(1, (readingTop - current.top) / Math.max(1, next.top - current.top)))
      : 0;
    const distance = current.distance + (next ? (next.distance - current.distance) * fraction : 0);
    const point = track.getPointAtLength(distance);
    let rotation = 0;
    if (!lowMotion) {
      const ahead = track.getPointAtLength(Math.min(length, distance + 1));
      const behind = track.getPointAtLength(Math.max(0, distance - 1));
      rotation = (Math.atan2(ahead.y - behind.y, ahead.x - behind.x) * 180) / Math.PI + 45;
    }
    const transform = `translate(${point.x}px, ${point.y}px) rotate(${rotation}deg)`;
    if (beforeHydration) {
      // Match React's inline-style serialization when adopting the prepainted DOM.
      plane.setAttribute("style", `transform:${transform}`);
      progress.setAttribute(
        "style",
        `stroke-dasharray:${length}, ${length};stroke-dashoffset:${length - distance}`,
      );
    } else {
      plane.style.transform = transform;
      progress.style.strokeDashoffset = String(length - distance);
    }
    links.forEach((link, row) => {
      const passed = String(row <= current.row);
      if (link.dataset.passed !== passed) link.dataset.passed = passed;
    });
  };
  const schedule = () => {
    if (!frame && stops.length > 0) frame = requestAnimationFrame(paint);
  };

  // The li remains rail-relative; its animated transform makes the link's
  // offsetTop relative to that li instead, so link offsets cannot locate rows.
  const measure = () => {
    if (disposed) return;
    if (root.getClientRects().length === 0) {
      stops = [];
      return;
    }
    let path = "";
    let previous: { x: number; y: number } | undefined;
    stops = [];
    links.forEach((link, index) => {
      const depth = Number(link.parentElement?.dataset.depth);
      const heading = document.getElementById(decodeURIComponent(link.hash.slice(1)));
      if (!heading) return;
      const x = 8 + Math.max(0, depth - minDepth) * 12;
      const row = link.parentElement!;
      const y = row.offsetTop + row.offsetHeight / 2;
      if (!previous) {
        path = `M ${x} ${y}`;
        readingOffset = Number.parseFloat(getComputedStyle(heading).scrollMarginTop) || 24;
      } else if (previous.x === x) {
        path += ` L ${x} ${y}`;
      } else {
        const mid = (previous.y + y) / 2;
        const bend = Math.min(4, Math.abs(x - previous.x) / 2, (y - previous.y) / 4);
        const direction = Math.sign(x - previous.x);
        path += ` L ${previous.x} ${mid - bend} Q ${previous.x} ${mid} ${previous.x + bend * direction} ${mid} L ${x - bend * direction} ${mid} Q ${x} ${mid} ${x} ${mid + bend} L ${x} ${y}`;
      }
      track.setAttribute("d", path);
      stops.push({
        top: window.scrollY + heading.getBoundingClientRect().top,
        distance: track.getTotalLength(),
        row: index,
      });
      previous = { x, y };
    });
    root.dataset.measured = String(stops.length > 0);
    if (stops.length === 0) return;
    length = track.getTotalLength();
    progress.setAttribute("d", path);
    if (!beforeHydration) progress.style.strokeDasharray = `${length} ${length}`;
    paint();
  };
  const observer = new ResizeObserver(measure);
  observer.observe(root);
  const article = document.getElementById("nd-page");
  if (article) observer.observe(article);
  const routeObserver = new MutationObserver(schedule);
  if (rail)
    routeObserver.observe(rail, {
      attributes: true,
      attributeFilter: ["data-toc-transition"],
    });
  window.addEventListener("scroll", schedule, { passive: true });
  window.addEventListener("resize", measure);
  void document.fonts.ready.then(measure);
  measure();
  const dispose = () => {
    disposed = true;
    observer.disconnect();
    routeObserver.disconnect();
    window.removeEventListener("scroll", schedule);
    window.removeEventListener("resize", measure);
    cancelAnimationFrame(frame);
    owners.delete(root);
  };
  owners.set(root, dispose);
  return dispose;
}
