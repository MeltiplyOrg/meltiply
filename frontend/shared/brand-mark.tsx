import type { ReactElement } from "react";

export function BrandMark({
  small = false,
  className,
}: {
  small?: boolean;
  className?: string;
}): ReactElement {
  return (
    <svg
      data-brand-mark=""
      data-small={small ? "" : undefined}
      className={className}
      viewBox="0 0 150 146"
      fill="currentColor"
      aria-hidden="true"
    >
      <polygon points="2.2 123.5 23.4 143.9 56.8 143.9 56.8 109.6 42.1 94.9 42.1 72.2 2.2 38" />
      <polygon points="114.3 2.3 75.2 46 36.4 2.3 2.2 2.2 2.2 30.3 66.1 84.3 75.2 75.5 84.6 84.4 147.8 30.3 147.8 2.3" />
      <polygon points="147.8 38 107.9 72.2 107.9 94.9 93.6 109.6 93.6 143.9 126.7 143.8 147.8 123.5" />
      <polygon data-brand-accent="" points="65.2 88.8 75.3 79.2 85.2 88.8 75.3 98.8" />
    </svg>
  );
}
