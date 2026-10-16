import type { ReactElement } from "react";

import {
  AnimatedCalendar,
  AnimatedClock,
  AnimatedImage,
  AnimatedLayers,
  AnimatedPlus,
  AnimatedShare,
  AnimatedSquarePen,
  ControlIcon,
} from "@meltiply/ui/animated-icons";

const icons = {
  calendar: AnimatedCalendar,
  clock: AnimatedClock,
  image: AnimatedImage,
  layers: AnimatedLayers,
  pen: AnimatedSquarePen,
  plus: AnimatedPlus,
  share: AnimatedShare,
} as const;

type AnimatedIconName = keyof typeof icons;

interface Props {
  name: AnimatedIconName;
  /** CSS selector resolved via `closest()`; pointer/focus on it drives the hover loop. */
  control?: string;
}

/**
 * Landing entry point for the shared animated icon set.
 *
 * Astro mounts one provider-free React island per usage; `ControlIcon` binds each icon's hover
 * loop to its containing interactive control (preview tab, button, feature card) so feedback
 * triggers on the whole control, not just the glyph. The shared Lucide-derived
 * geometry and default two-pixel strokes match app controls; icons stay decorative
 * because surrounding markup carries labels. CSS owns their reserved size.
 *
 * @param props - Icon name plus optional ancestor control selector.
 * @returns Control-bound shared animated icon island.
 */
export default function AnimatedIcon({ name, control }: Props): ReactElement {
  return <ControlIcon icon={icons[name]} control={control} iconProps={{ "aria-hidden": true }} />;
}
