import { readFileSync } from "node:fs";
import { expect, it } from "vite-plus/test";
import { effectEasing, effectMoveEasing } from "@meltiply/ui/effects";

it("keeps WAAPI easings identical to the shared CSS curves", () => {
  const motionCss = readFileSync(new URL("../../../shared/motion.css", import.meta.url), "utf8");
  expect(motionCss).toContain(`--ease-enter: ${effectEasing};`);
  expect(motionCss).toContain(`--ease-drawer: ${effectMoveEasing};`);
});
