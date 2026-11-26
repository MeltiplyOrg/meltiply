import { Moon, Sun } from "lucide-react";
import type { ReactElement } from "react";

export function ThemeIcon({ className = "" }: { className?: string }): ReactElement {
  return (
    <span className={className} data-preference-icon="theme" aria-hidden="true">
      <Sun data-preference-glyph="sun" />
      <Moon data-preference-glyph="moon" />
    </span>
  );
}
