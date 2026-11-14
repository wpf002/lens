import { useEffect } from "react";
import { useStore } from "./store";
import { VIEW_ORDER } from "./types";

function isTyping(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || el.isContentEditable;
}

/** Global shortcuts: / and Cmd/Ctrl+K search, ? help, Esc, 1-5 views, f fit, arrows for the tour. */
export function useKeyboard(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = useStore.getState();
      if (s.status !== "ready") return;
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        s.focusSearch();
        return;
      }
      if (e.key === "Escape") {
        if (isTyping(e.target)) (e.target as HTMLElement).blur();
        s.clearTransient();
        return;
      }
      if (isTyping(e.target) || e.metaKey || e.ctrlKey || e.altKey) return;
      if (s.modal && e.key !== "?") return;
      if (e.key === "/") {
        e.preventDefault();
        s.focusSearch();
      } else if (e.key === "?") {
        e.preventDefault();
        s.setModal(s.modal === "help" ? null : "help");
      } else if (e.key === "f" || e.key === "F") {
        s.requestFit();
      } else if (/^[1-9]$/.test(e.key)) {
        const v = VIEW_ORDER[Number(e.key) - 1];
        if (v) s.setView(v);
      } else if (s.tour.active && (e.key === "ArrowRight" || e.key === "ArrowLeft")) {
        e.preventDefault();
        s.tourStep(e.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
