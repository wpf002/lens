import { useMemo } from "react";
import { useStore } from "../store";
import { compileFilters, type CompiledFilters } from "../utils/filters";
import type { GraphModel } from "../utils/model";
import type { OverlayInput } from "../utils/overlay";
import { findingFocus } from "../utils/security";

export function useModel(): GraphModel {
  const model = useStore((s) => s.model);
  if (!model) throw new Error("Graph not loaded");
  return model;
}

export function useCompiledFilters(): CompiledFilters {
  const model = useModel();
  const filters = useStore((s) => s.filters);
  return useMemo(() => compileFilters(model, filters), [model, filters]);
}

/** Current spotlight: path > finding > tour step > search highlight. */
export function useFocusIds(): string[] | null {
  const model = useModel();
  const path = useStore((s) => s.pathState.path);
  const finding = useStore((s) => s.selectedFinding);
  const tour = useStore((s) => s.tour);
  const search = useStore((s) => s.searchHighlight);
  return useMemo(() => {
    if (path?.length) return path;
    if (finding) return findingFocus(model, finding);
    if (tour.active) return model.graph.tour[tour.index]?.nodeIds ?? null;
    if (search?.ids.length) return search.ids;
    return null;
  }, [model, path, finding, tour, search]);
}

export function useOverlayInput(focusV?: ReadonlySet<string> | null): OverlayInput {
  const focus = useFocusIds();
  const diffOn = useStore((s) => s.diffOn);
  const diff = useStore((s) => s.diff);
  const selected = useStore((s) => s.selectedId);
  return useMemo(() => ({ focus, focusV, diff: diffOn ? diff : null, selected }), [focus, focusV, diffOn, diff, selected]);
}
