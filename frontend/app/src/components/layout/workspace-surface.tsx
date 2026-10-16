import { useMemo, type ReactNode } from "react";
import { AnimatePresence, motion, useIsPresent, type Transition } from "motion/react";
import { cn } from "@meltiply/ui/utils";
import { useMotionPreference } from "@meltiply/ui/motion-preference";

interface WorkspaceSurfaceProps {
  title: ReactNode;
  description: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  contentClassName?: string;
}

/**
 * Renders localized text with sequential word-by-word morph kinematics.
 *
 * Deconstructs the string into individual word tokens, animating each with a
 * staggered vertical drift, optical blur dissolve, and opacity transition (`delay: index * stagger`).
 * Preserves natural typography and line wrapping. The same word-split
 * `inline-flex gap-x-1.5` structure renders in both motion modes — under
 * `lowMotion` each word mounts at its resting state (`initial={false}`,
 * opacity-only exit, zero duration, no stagger) — so toggling the preference
 * never remounts the text or changes its spacing: the flex gaps stay identical
 * instead of swapping to plain text's narrower natural word spaces.
 *
 * Accessibility contract: the animated word spans are `aria-hidden` because they contain no
 * whitespace between siblings (spacing is the `gap-x-1.5` flex gap), so assistive technology
 * would announce them as one concatenated token. A visually hidden copy of the full string
 * supplies the accessible text with natural word spacing instead. `useIsPresent` reads the
 * surrounding `AnimatePresence` context, so while an outgoing title or description is still
 * animating out under `popLayout`, its whole subtree (including that hidden copy) drops out
 * of the accessibility tree and the surface keeps exactly one accessible name in flight.
 *
 * @param props.text - The localized text string or React node to animate.
 * @param props.transition - Base transition timing and curve.
 * @param props.yOffset - Vertical travel distance for entry and exit.
 * @param props.blurRadius - Maximum optical blur applied during transition.
 * @param props.stagger - Delay multiplier between consecutive words in seconds.
 * @param props.lowMotion - Effective low-motion preference; disables travel, blur, and stagger.
 * @returns Fluid typography component with word-staggered morph transitions.
 */
function MorphingWords({
  text,
  transition,
  yOffset = 6,
  blurRadius = 4,
  stagger = 0.055,
  lowMotion = false,
}: {
  text: ReactNode;
  transition?: Transition;
  yOffset?: number;
  blurRadius?: number;
  stagger?: number;
  lowMotion?: boolean;
}) {
  const isPresent = useIsPresent();
  const words = useMemo(() => {
    if (typeof text !== "string") return [];
    return text.trim().split(/\s+/);
  }, [text]);

  if (typeof text !== "string") {
    return <span aria-hidden={!isPresent}>{text}</span>;
  }

  return (
    <span className="inline-flex flex-wrap gap-x-1.5" aria-hidden={!isPresent}>
      <span className="sr-only">{text}</span>
      {words.map((word, i) => (
        <motion.span
          key={`${word}-${i}`}
          initial={lowMotion ? false : { opacity: 0, y: yOffset, filter: `blur(${blurRadius}px)` }}
          animate={{ opacity: 1, y: 0, filter: "blur(0px)" }}
          exit={
            lowMotion
              ? { opacity: 0 }
              : { opacity: 0, y: -yOffset, filter: `blur(${blurRadius}px)` }
          }
          transition={{
            ...(lowMotion ? { duration: 0 } : transition),
            delay: lowMotion ? 0 : Math.min(i * stagger, 0.2),
          }}
          className="inline-block whitespace-nowrap"
          aria-hidden="true"
        >
          {word}
        </motion.span>
      ))}
    </span>
  );
}
/**
 * Establishes the shared workspace-page geometry used by operational views.
 *
 * A small slot interface keeps title, actions, toolbar, and working area at identical
 * anchors with a reserved vertical gap between controls and the work surface. Each route
 * owns task-specific content while shared layout IDs let the navigation shell morph stable anchors.
 * Title and description crossfade via `AnimatePresence` `popLayout`; `MorphingWords` hides the
 * exiting copy from assistive technology, so the header exposes exactly one accessible name
 * while the outgoing text finishes its exit animation. The same `AnimatePresence`/`motion.span`
 * tree renders in both motion modes — under the shared low-motion preference (manual or OS)
 * `initial` is suppressed, exits are opacity-only, and durations drop to zero — so toggling the
 * preference never remounts the header or changes its spacing, and the destination is never
 * delayed or hidden behind an in-flight transition.
 */
export function WorkspaceSurface({
  title,
  description,
  actions,
  children,
  className,
  contentClassName,
}: WorkspaceSurfaceProps) {
  const { lowMotion } = useMotionPreference();
  const textTransition: Transition = { duration: 0.42, ease: [0.16, 1, 0.3, 1] };
  const descriptionTransition: Transition = { duration: 0.32, ease: [0.16, 1, 0.3, 1] };

  return (
    <div className={cn("flex h-full min-h-0 w-full flex-col gap-4 overflow-hidden", className)}>
      <header className="flex shrink-0 select-none flex-col justify-between gap-4 sm:flex-row sm:items-center sm:h-[3.625rem] sm:min-h-[3.625rem]">
        <div className="min-w-0">
          <h1 className="relative text-2xl font-bold tracking-tight text-ink sm:text-3xl sm:h-9 sm:leading-9 flex items-center">
            <AnimatePresence mode="popLayout">
              <motion.span
                key={typeof title === "string" ? title : undefined}
                initial={lowMotion ? false : { opacity: 0, y: 7 }}
                animate={{ opacity: 1, y: 0 }}
                exit={lowMotion ? { opacity: 0 } : { opacity: 0, y: -7 }}
                transition={lowMotion ? { duration: 0 } : textTransition}
                className="inline-block"
              >
                <MorphingWords
                  text={title}
                  transition={textTransition}
                  yOffset={7}
                  blurRadius={4}
                  stagger={0.06}
                  lowMotion={lowMotion}
                />
              </motion.span>
            </AnimatePresence>
          </h1>
          <p className="mt-0.5 text-sm text-ink-2 sm:h-5 sm:leading-5 flex items-center">
            <AnimatePresence mode="popLayout">
              <motion.span
                key={typeof description === "string" ? description : undefined}
                initial={lowMotion ? false : { opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={lowMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
                transition={lowMotion ? { duration: 0 } : descriptionTransition}
                className="inline-block"
              >
                <MorphingWords
                  text={description}
                  transition={descriptionTransition}
                  yOffset={4}
                  blurRadius={3}
                  stagger={0.025}
                  lowMotion={lowMotion}
                />
              </motion.span>
            </AnimatePresence>
          </p>
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>

      <div className={cn("flex min-h-0 flex-1 flex-col gap-4 overflow-hidden", contentClassName)}>
        {children}
      </div>
    </div>
  );
}
