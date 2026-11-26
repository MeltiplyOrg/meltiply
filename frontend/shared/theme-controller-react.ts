import { useEffect, useState, useSyncExternalStore } from "react";
import {
  createThemeController,
  type ThemeController,
  type ThemeControllerState,
} from "./theme-controller";

export interface ThemeControllerHandle {
  controller: ThemeController;
  state: ThemeControllerState;
}

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
