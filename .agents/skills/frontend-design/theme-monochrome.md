# Theme Tokens, Color Palette & Visual Description

The visual design system uses a cool near-white canvas, white cards, hairline borders, layered single-digit-opacity shadows, a neutral ink ramp, and semantic colors used sparingly as an intentional condiment. Token definitions live in `frontend/shared/tokens.css` (mapped to Tailwind utilities via `@theme inline`); this file is the lookup for their values and intent.

## Visual Ethos

1. **Surfaces**: Cool, blue-tinted neutral backgrounds (`--page`, `--canvas`) that keep interfaces calm and legible. Interactive cards use solid, high-contrast surfaces (`--surface`) with subtle inset fields (`--inset`, `--field`).
2. **Ink Ramp**: A 3-step value ramp (`--ink`, `--ink-2`, `--ink-3`) provides clear typographical hierarchy without color noise.
3. **Hairline Boundaries**: Solid, crisp borders (`--line`, `--line-strong`) define edges cleanly rather than fuzzy alpha fades.
4. **Textured Canvas**: The body features a subtle, fixed 45-degree repeating diagonal stripe texture (`--stripe-bg`, `--stripe`) that grounds floating surface cards and windows.
5. **Layered Elevation**: Shadow stacks combine a solid 1px hairline ring with soft, multi-tier ambient occlusion for a tactile, floating feel.

## Token Specification Table

| Token Variable  | Light Mode (OKLCH)           | Dark Mode (OKLCH)                  | Tailwind Class                        | Purpose                        |
| --------------- | ---------------------------- | ---------------------------------- | ------------------------------------- | ------------------------------ |
| `--page`        | `oklch(0.985 0.001 286.376)` | `oklch(0.209 0.004 264.477)`       | `bg-page`, `bg-background`            | Viewport / main background     |
| `--canvas`      | `oklch(0.961 0.002 247.84)`  | `oklch(0.231 0.004 264.487)`       | `bg-canvas`                           | Secondary canvas, rails        |
| `--surface`     | `oklch(1 0 0)`               | `oklch(0.26 0.006 271.191)`        | `bg-surface`, `bg-card`               | Cards, modals, elevated panels |
| `--inset`       | `oklch(0.979 0.002 247.839)` | `oklch(0.243 0.004 264.492)`       | `bg-inset`, `bg-muted`                | Recessed fields, tags          |
| `--hover`       | `oklch(0.97 0.002 247.839)`  | `oklch(0.289 0.006 271.22)`        | `bg-hover`                            | Interactive hover fill         |
| `--hover-2`     | `oklch(0.933 0.003 247.86)`  | `oklch(0.318 0.007 274.747)`       | `bg-hover-2`                          | Active item highlight          |
| `--ink`         | `oklch(0.247 0.006 258.361)` | `oklch(0.964 0.002 247.839)`       | `text-ink`, `text-foreground`         | Primary text & titles          |
| `--ink-2`       | `oklch(0.506 0.01 264.477)`  | `oklch(0.731 0.008 260.731)`       | `text-ink-2`, `text-muted-foreground` | Body text, explanations        |
| `--ink-3`       | `oklch(0.695 0.009 264.505)` | `oklch(0.541 0.01 264.484)`        | `text-ink-3`                          | Captions, metadata, icons      |
| `--line`        | `oklch(0.946 0.003 264.542)` | `oklch(0.308 0.006 258.354)`       | `border-line`, `border-border`        | Standard 1px dividers          |
| `--line-strong` | `oklch(0.912 0.005 258.326)` | `oklch(0.356 0.007 264.474)`       | `border-line-strong`                  | Active / focused borders       |
| `--accent`      | `oklch(0.626 0.205 254.947)` | `oklch(0.68 0.173 253.301)`        | `text-accent`, `bg-accent`            | Brand violet/indigo accent     |
| `--accent-tint` | `oklch(0.96 0.019 252.878)`  | `oklch(0.68 0.173 253.301 / 16%)`  | `bg-accent-tint`                      | Pill backgrounds, selections   |
| `--green`       | `oklch(0.603 0.155 150.883)` | `oklch(0.705 0.154 153.814)`       | `text-green`                          | Success, published status      |
| `--green-tint`  | `oklch(0.958 0.017 159.118)` | `oklch(0.705 0.154 153.814 / 14%)` | `bg-green-tint`                       | Success badge background       |
| `--orange`      | `oklch(0.689 0.179 49.902)`  | `oklch(0.746 0.156 55.642)`        | `text-orange`                         | Warnings, review needed        |
| `--orange-tint` | `oklch(0.964 0.021 67.581)`  | `oklch(0.746 0.156 55.642 / 14%)`  | `bg-orange-tint`                      | Warning badge background       |
| `--red`         | `oklch(0.621 0.192 23.042)`  | `oklch(0.666 0.18 21.433)`         | `text-red`                            | Destructive, failed posts      |
| `--red-tint`    | `oklch(0.956 0.017 17.462)`  | `oklch(0.666 0.18 21.433 / 14%)`   | `bg-red-tint`                         | Error badge background         |

## Striped Background Canvas

The application background uses a fixed, subtle 45-degree repeating linear gradient:

```css
body {
  background-color: var(--stripe-bg);
  background-image: repeating-linear-gradient(
    -45deg,
    transparent 0,
    transparent 7px,
    var(--stripe) 7px,
    var(--stripe) 8px
  );
  background-attachment: fixed;
  color: var(--ink);
  min-height: 100vh;
}
```

## Layered Shadow Stacks

Shadows are composed of a crisp hairline boundary coupled with smooth elevation layers:

```css
--shadow-hairline: 0 0 0 1px var(--line);
--shadow-btn: 0 0 0 1px var(--line-strong), 0 1px 2px oklch(0 0 0 / 0.04);
--shadow-card: 0 0 0 1px var(--line), 0 1px 3px oklch(0 0 0 / 0.04), 0 1px 2px oklch(0 0 0 / 0.02);
--shadow-raised: 0 0 0 1px var(--line), 0 4px 12px oklch(0 0 0 / 0.06);
--shadow-overlay: 0 0 0 1px var(--line), 0 12px 32px oklch(0 0 0 / 0.12);
--shadow-inset-field: inset 0 1px 2px oklch(0 0 0 / 0.08);
```

## Standard Radii Scale

Apply consistent corner rounding based on component role:

- **6px (`rounded-chip`)**: Inline tokens, status pills, and small indicators.
- **8px (`rounded-control`)**: Buttons, inputs, dropdown items, and navigation buttons.
- **10px (`rounded-card`)**: Surface cards, forms, insight panels, and tables.
- **14px (`rounded-window`)**: Modals, large floating dialogs, and workspace drawers.
