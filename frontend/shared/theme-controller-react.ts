import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createThemeController,
  type ThemeController,
  type ThemeControllerState,
} from "./theme-controller";

/** One mounted controller and its published state for a React surface. */
export interface ThemeControllerHandle {
  controller: ThemeController;
  state: ThemeControllerState;
}

/**
 * Owns one browser theme controller for a React provider's lifetime.
 *
 * The controller is created once per mount, starts its subscriptions in an
 * effect, and feeds React through `useSyncExternalStore` with the server
 * snapshot before hydration. Astro and app providers only project this state
 * into their own labels and controls.
 *
 * @returns The controller for actions plus its current committed snapshot.
 */
export function useThemeController(): ThemeControllerHandle {
  const [controller] = useState(createThemeController);
  useEffect(() => controller.start(), [controller]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getServerSnapshot,
  );
  return { controller, state };
}
