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
  control?: string;
}

export default function AnimatedIcon({ name, control }: Props): ReactElement {
  return <ControlIcon icon={icons[name]} control={control} iconProps={{ "aria-hidden": true }} />;
}
