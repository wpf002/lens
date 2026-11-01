import type { ViewModel } from "../types";

/** The canvas currently on screen, for exports (PNG/SVG/Mermaid). */
export interface CanvasHandle {
  vm: ViewModel | null;
  element: HTMLElement | null;
  getBounds: () => { x: number; y: number; width: number; height: number } | null;
}

let current: CanvasHandle = { vm: null, element: null, getBounds: () => null };

export const canvasRegistry = {
  set(h: CanvasHandle) {
    current = h;
  },
  get(): CanvasHandle {
    return current;
  },
};
