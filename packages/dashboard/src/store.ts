import { create } from "zustand";
import { EDGE_KINDS, shortestPath, type EdgeKind, type ImpactReport } from "@lens/core/browser";

const NON_CODE_EDGES = new Set<EdgeKind>([
  "contains_flow", "flow_step", "cross_domain", "implemented_by", "links_to", "cites", "contradicts", "builds_on", "categorized_under", "related", "similar_to",
]);
import {
  UnauthorizedError,
  cancelEnrichJob,
  clearFileCache,
  fetchEnrichStatus,
  fetchAudit,
  fetchReview,
  fetchRemediation,
  applyRemediation,
  undoRemediation,
  type RemediationRecord,
  type AIJobOptions,
  type RemediationSource,
  type FixAllPlans,
  type CostEstimate,
  type ReviewRecord,
  startAIJob,
  fetchPushState,
  setWontFix,
  type PushState,
  type AuditRecord,
  type EnrichJob,
  detectMode,
  openProjectPath,
  pickProjectFolder,
  fetchDiff,
  initToken,
  loadInitial,
  setToken,
  type DataMode,
  type Meta,
} from "./api";
import { VIEW_ORDER, type ViewId } from "./types";
import { FLAT_THRESHOLD } from "./utils/aggregate";
import { DEFAULT_FILTERS, sanitizeFilters, type Filters } from "./utils/filters";
import { DOMAIN_NODE_KINDS, KNOWLEDGE_NODE_KINDS, buildModel, commonDir, type GraphModel } from "./utils/model";
import { DEFAULT_SECURITY_FILTER, SINK_PREFIX, findingFocus, type SecurityFilter } from "./utils/security";
import { loadPrefs, savePrefs } from "./utils/storage";
import { validateGraph } from "./utils/validate";
import { dirOf } from "@lens/core/browser";

export type SidebarTab = "overview" | "node" | "tour" | "files" | "diff";
export type Modal = "help" | "filters" | "path" | "welcome" | "project" | null;

export interface CodeState {
  open: boolean;
  path: string | null;
  lines?: [number, number];
  focusLine?: number;
  full: boolean;
  title?: string;
}

export interface PathState {
  from: string | null;
  to: string | null;
  path: string[] | null;
  searched: boolean;
}

export interface State {
  status: "loading" | "ready" | "error" | "unauthorized";
  error?: string;
  mode: DataMode;
  model: GraphModel | null;
  meta: Meta | null;
  warnings: string[];
  dismissed: { warnings: boolean; stale: boolean };

  view: ViewId;
  structureDir: string;
  structureFlat: boolean;
  expanded: string[];
  selectedId: string | null;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  tour: { active: boolean; index: number };
  searchHighlight: { query: string; ids: string[] } | null;
  diffOn: boolean;
  diff: ImpactReport | null;
  diffStatus: "idle" | "loading" | "error";
  diffError?: string;
  filters: Filters;
  secFilter: SecurityFilter;
  selectedFinding: string | null;
  layerIsolate: string | null;
  expandedStep: string | null;
  pathState: PathState;
  code: CodeState;
  modal: Modal;
  /** Switching projects: "picking" while the Finder dialog is open, then "scanning". */
  projectOp: { busy: "picking" | "scanning" | null; error: string | null };
  /** Latest Claude Code enrichment run for this project (server mode). */
  enrichJob: EnrichJob;
  /** Last AI audit verdicts (server mode). */
  audit: AuditRecord | null;
  /** The audit confirm step is showing (opened from the Security header). */
  auditConfirm: boolean;
  /** Last AI code review (server mode). */
  review: ReviewRecord | null;
  reviewConfirm: boolean;
  /** Proposed fixes from the last Remediate run, plus cost estimates per source. */
  remediation: Partial<Record<RemediationSource, RemediationRecord | null>>;
  remediationEstimates: Partial<Record<RemediationSource, CostEstimate>>;
  /** Automatic checks that offer Fix with AI, and how many hits one run takes. */
  fixable: { batch: number; items: number; plans?: FixAllPlans };
  remediateConfirm: { source: RemediationSource; checkId?: string } | null;
  fixOp: { busy: boolean; error: string | null };
  refreshRemediation(): Promise<void>;
  applyFixes(source: RemediationSource, ids: string[]): Promise<void>;
  undoFix(source: RemediationSource, id: string): Promise<void>;
  menuOpen: boolean;
  focus: { ids: string[]; nonce: number } | null;
  fitNonce: number;
  searchFocusNonce: number;

  init(): Promise<void>;
  submitToken(token: string): Promise<void>;
  setView(v: ViewId): void;
  setDir(dir: string): void;
  setFlat(flat: boolean): void;
  toggleExpanded(fileId: string): void;
  select(id: string | null, opts?: { focus?: boolean }): void;
  navigateTo(id: string): void;
  setSidebar(open: boolean, tab?: SidebarTab): void;
  setSidebarTab(tab: SidebarTab): void;
  startTour(index?: number): void;
  stopTour(): void;
  tourStep(delta: number): void;
  setSearchHighlight(h: State["searchHighlight"]): void;
  toggleDiff(on?: boolean): Promise<void>;
  setFilters(patch: Partial<Filters>): void;
  resetFilters(): void;
  setSecFilter(patch: Partial<SecurityFilter>): void;
  selectFinding(id: string | null, opts?: { code?: boolean }): void;
  setLayerIsolate(id: string | null): void;
  setExpandedStep(id: string | null): void;
  openPathFinder(from?: string | null): void;
  setPathEnds(patch: Partial<Pick<PathState, "from" | "to">>): void;
  runPath(): void;
  clearPath(): void;
  openCode(path: string, opts?: { lines?: [number, number]; focusLine?: number; title?: string }): void;
  closeCode(): void;
  toggleCodeFull(): void;
  pickProject(): Promise<void>;
  runAI(task: NonNullable<EnrichJob["task"]>, opts?: AIJobOptions): Promise<void>;
  /** Health and review items closed as Won't Fix (stable ids). */
  wontFix: string[];
  toggleWontFix(id: string, on: boolean): Promise<void>;
  /** Hosted: where applied fixes are (branch, pull request, merged). */
  push: PushState;
  refreshPush(): Promise<void>;
  /** Re-fetch graph, remediation and pull request state after the repo changed. */
  reloadProject(): Promise<void>;
  cancelAI(): Promise<void>;
  watchAI(): void;
  openProject(path: string): Promise<void>;
  setModal(m: Modal): void;
  setMenu(open: boolean): void;
  requestFocus(ids: string[]): void;
  requestFit(): void;
  focusSearch(): void;
  clearTransient(): void;
  dismiss(which: "warnings" | "stale"): void;
}

/** Recently opened project folders, most recent first. */
export function recentProjects(): string[] {
  const r = loadPrefs().recentProjects;
  return Array.isArray(r) ? r.filter((x): x is string => typeof x === "string").slice(0, 8) : [];
}
function rememberProject(root: string): void {
  savePrefs({ recentProjects: [root, ...recentProjects().filter((r) => r !== root)].slice(0, 8) });
}

/** View state that belongs to one project and must not leak into the next. */
const PROJECT_RESET = {
  structureDir: "",
  expanded: [] as string[],
  selectedId: null,
  tour: { active: false, index: 0 },
  searchHighlight: null,
  diffOn: false,
  diff: null,
  diffStatus: "idle" as const,
  selectedFinding: null,
  layerIsolate: null,
  expandedStep: null,
  pathState: { from: null, to: null, path: null, searched: false },
  code: { open: false, path: null, full: false },
  focus: null,
  sidebarTab: "overview" as const,
  auditConfirm: false,
  reviewConfirm: false,
};

const prefs = typeof window !== "undefined" ? loadPrefs() : {};
const startView: ViewId = VIEW_ORDER.includes(prefs.view as ViewId) ? (prefs.view as ViewId) : "structure";

/** Which view can show a node best, given where the user currently is. */
export function viewFor(model: GraphModel, id: string, current: ViewId): ViewId {
  const n = model.idx.nodes.get(id);
  if (id.startsWith(SINK_PREFIX)) return "security";
  if (!n) return current;
  if (DOMAIN_NODE_KINDS.has(n.kind)) return "domain";
  if (KNOWLEDGE_NODE_KINDS.has(n.kind) && !model.owner.get(id)) return "knowledge";
  if (current === "knowledge" && model.hasKnowledge && model.graph.kind === "knowledge") return current;
  if (current === "security" && (n.kind === "endpoint" || (model.graph.security?.exposure ?? []).some((x) => x.path.includes(id)))) return current;
  if (current === "layers" && model.owner.get(id)) return current;
  if (current === "domain" && (model.idx.in.get(id) ?? []).some((e) => e.kind === "implemented_by")) return "structure";
  return model.owner.get(id) ? "structure" : current;
}

export const useStore = create<State>((set, get) => ({
  status: "loading",
  mode: "server",
  model: null,
  meta: null,
  warnings: [],
  dismissed: { warnings: false, stale: false },

  view: startView,
  structureDir: "",
  structureFlat: false,
  expanded: [],
  selectedId: null,
  sidebarOpen: typeof window !== "undefined" ? window.innerWidth >= 900 : true,
  sidebarTab: "overview",
  tour: { active: false, index: 0 },
  searchHighlight: null,
  diffOn: false,
  diff: null,
  diffStatus: "idle",
  filters: sanitizeFilters(prefs.filters ?? DEFAULT_FILTERS),
  secFilter: DEFAULT_SECURITY_FILTER,
  selectedFinding: null,
  layerIsolate: null,
  expandedStep: null,
  pathState: { from: null, to: null, path: null, searched: false },
  code: { open: false, path: null, full: false },
  modal: null,
  projectOp: { busy: null, error: null },
  enrichJob: { state: "idle" },
  audit: null,
  auditConfirm: false,
  review: null,
  reviewConfirm: false,
  remediation: {},
  remediationEstimates: {},
  wontFix: [],
  push: null,
  fixable: { batch: 15, items: 0 },
  remediateConfirm: null,
  fixOp: { busy: false, error: null },
  menuOpen: false,
  focus: null,
  fitNonce: 0,
  searchFocusNonce: 0,

  async init() {
    initToken();
    const mode = detectMode();
    set({ status: "loading", mode });
    try {
      const data = await loadInitial(mode);
      const { graph, warnings } = validateGraph(data.graph);
      const model = buildModel(graph);
      const meta: Meta = data.meta ?? { project: graph.project, hasEmbeddings: false, git: mode === "dev" || !!data.diff };
      let view = get().view;
      if (view === "knowledge" && !model.hasKnowledge) view = "structure";
      // Knowledge bases have no code structure; open straight into the knowledge view.
      if (graph.kind === "knowledge" && model.hasKnowledge) view = "knowledge";
      set({
        status: "ready",
        model,
        meta,
        warnings,
        diff: data.diff,
        view,
        structureFlat: model.totalFiles <= FLAT_THRESHOLD,
        // First visit: show the intro once.
        modal: loadPrefs().introSeen ? get().modal : "welcome",
      });
      // Pick up an AI run that was started before this page loaded.
      if (mode === "server" && data.meta?.canEnrich) {
        get().watchAI();
        void fetchAudit().then((audit) => set({ audit }), () => set({ audit: null }));
        void fetchReview().then((review) => set({ review }), () => set({ review: null }));
        void get().refreshRemediation();
      }
    } catch (err) {
      if (err instanceof UnauthorizedError) set({ status: "unauthorized" });
      else set({ status: "error", error: err instanceof Error ? err.message : String(err) });
    }
  },

  async submitToken(token) {
    setToken(token);
    await get().init();
  },

  setView(v) {
    const { model } = get();
    if (v === "knowledge" && model && !model.hasKnowledge) return;
    savePrefs({ view: v });
    set({ view: v, menuOpen: false, layerIsolate: null });
    const { selectedId, tour } = get();
    if (tour.active) get().tourStep(0);
    else if (selectedId) get().requestFocus([selectedId]);
  },

  setDir(dir) {
    set({ structureDir: dir, structureFlat: false });
  },
  setFlat(flat) {
    set({ structureFlat: flat });
  },
  toggleExpanded(fileId) {
    const cur = new Set(get().expanded);
    if (cur.has(fileId)) cur.delete(fileId);
    else cur.add(fileId);
    set({ expanded: [...cur] });
  },

  select(id, opts) {
    if (!id) {
      set({ selectedId: null, sidebarTab: get().sidebarTab === "node" ? (get().tour.active ? "tour" : "overview") : get().sidebarTab });
      return;
    }
    set({ selectedId: id, sidebarTab: "node", sidebarOpen: true });
    if (opts?.focus) get().requestFocus([id]);
  },

  navigateTo(id) {
    const { model, view } = get();
    if (!model) return;
    const target = viewFor(model, id, view);
    const patch: Partial<State> = { view: target, selectedId: id, sidebarTab: "node", menuOpen: false };
    if (target === "structure") {
      const owner = model.owner.get(id);
      const file = owner ? model.fileById.get(owner) : undefined;
      if (file && !get().structureFlat) patch.structureDir = file.dir;
      if (owner && owner !== id) patch.expanded = [...new Set([...get().expanded, owner])];
    }
    if (target === "domain") {
      const n = model.idx.nodes.get(id);
      if (n?.kind === "step") patch.expandedStep = id;
    }
    if (target !== view) savePrefs({ view: target });
    set(patch);
    if (window.innerWidth >= 768) set({ sidebarOpen: true });
    get().requestFocus([id]);
  },

  setSidebar(open, tab) {
    set({ sidebarOpen: open, ...(tab ? { sidebarTab: tab } : {}) });
  },
  setSidebarTab(tab) {
    set({ sidebarTab: tab, sidebarOpen: true });
  },

  startTour(index = 0) {
    set({ tour: { active: true, index }, sidebarTab: "tour", sidebarOpen: true, searchHighlight: null, selectedFinding: null });
    get().tourStep(0);
  },
  stopTour() {
    set({ tour: { active: false, index: get().tour.index } });
  },
  tourStep(delta) {
    const { model, tour, view, structureFlat } = get();
    if (!model) return;
    const steps = model.graph.tour;
    if (!steps.length) return;
    const index = Math.max(0, Math.min(steps.length - 1, tour.index + delta));
    const step = steps[index]!;
    const patch: Partial<State> = { tour: { active: true, index } };
    let v = view;
    if (v !== "structure" && v !== "layers") v = "structure";
    patch.view = v;
    if (v === "structure" && !structureFlat) {
      const paths = step.nodeIds
        .map((id) => model.owner.get(id))
        .map((f) => (f ? model.fileById.get(f)?.path : undefined))
        .filter((p): p is string => !!p);
      const dirs = paths.map((p) => dirOf(p));
      patch.structureDir = paths.length ? (dirs.every((d) => d === dirs[0]) ? dirs[0]! : commonDir(paths)) : "";
    }
    set(patch);
    get().requestFocus(step.nodeIds);
  },

  setSearchHighlight(h) {
    set({ searchHighlight: h });
    if (h?.ids.length) get().requestFocus(h.ids);
  },

  async toggleDiff(on) {
    const next = on ?? !get().diffOn;
    if (!next) {
      set({ diffOn: false, sidebarTab: get().sidebarTab === "diff" ? "overview" : get().sidebarTab });
      return;
    }
    set({ diffOn: true, sidebarTab: "diff", sidebarOpen: true });
    const focusDiff = (d: ImpactReport) => get().requestFocus([...d.changed, ...d.impacted.map((x) => x.id)]);
    const existing = get().diff;
    if (existing) return focusDiff(existing);
    set({ diffStatus: "loading", diffError: undefined });
    try {
      const diff = await fetchDiff(get().mode);
      set({ diff, diffStatus: "idle" });
      focusDiff(diff);
    } catch (err) {
      if (err instanceof UnauthorizedError) set({ status: "unauthorized" });
      set({ diffStatus: "error", diffError: err instanceof Error ? err.message : String(err) });
    }
  },

  setFilters(patch) {
    const filters = { ...get().filters, ...patch };
    savePrefs({ filters });
    set({ filters });
  },
  resetFilters() {
    savePrefs({ filters: DEFAULT_FILTERS });
    set({ filters: DEFAULT_FILTERS });
  },
  setSecFilter(patch) {
    set({ secFilter: { ...get().secFilter, ...patch } });
  },
  selectFinding(id, opts) {
    const { model } = get();
    if (!id || !model) {
      set({ selectedFinding: null });
      return;
    }
    const f = model.findingById.get(id);
    set({ selectedFinding: id, view: "security", tour: { ...get().tour, active: false } });
    if (f) {
      set({ selectedId: f.nodeId, sidebarTab: "node" });
      if (opts?.code !== false) get().openCode(f.path, { focusLine: f.line, lines: [f.line, f.line], title: f.title });
    }
    get().requestFocus(findingFocus(model, id));
  },
  setLayerIsolate(id) {
    set({ layerIsolate: get().layerIsolate === id ? null : id });
  },
  setExpandedStep(id) {
    set({ expandedStep: id });
  },

  openPathFinder(from) {
    set({ modal: "path", menuOpen: false, pathState: { ...get().pathState, from: from ?? get().pathState.from, path: null, searched: false } });
  },
  setPathEnds(patch) {
    set({ pathState: { ...get().pathState, ...patch, path: null, searched: false } });
  },
  runPath() {
    const { model, pathState } = get();
    if (!model || !pathState.from || !pathState.to) return;
    // Code-to-code paths ignore domain/knowledge/semantic-similarity links, which would short-circuit real dependencies.
    const a = model.idx.nodes.get(pathState.from);
    const b = model.idx.nodes.get(pathState.to);
    const codeOnly = !!a && !!b && ![a, b].some((n) => DOMAIN_NODE_KINDS.has(n.kind) || KNOWLEDGE_NODE_KINDS.has(n.kind));
    const path =
      (codeOnly ? shortestPath(model.idx, pathState.from, pathState.to, { kinds: EDGE_KINDS.filter((k) => !NON_CODE_EDGES.has(k)) }) : null) ??
      shortestPath(model.idx, pathState.from, pathState.to);
    const patch: Partial<State> = { pathState: { ...pathState, path, searched: true } };
    if (path && get().view === "structure" && !get().structureFlat) {
      const paths = path.map((id) => model.fileById.get(model.owner.get(id) ?? "")?.path).filter((p): p is string => !!p);
      if (paths.length) patch.structureDir = commonDir(paths);
    }
    set(patch);
    if (path) get().requestFocus(path);
  },
  clearPath() {
    set({ pathState: { from: null, to: null, path: null, searched: false } });
  },

  openCode(path, opts) {
    set({ code: { open: true, path, lines: opts?.lines, focusLine: opts?.focusLine, full: get().code.full, title: opts?.title } });
  },
  closeCode() {
    set({ code: { ...get().code, open: false, full: false } });
  },
  toggleCodeFull() {
    set({ code: { ...get().code, full: !get().code.full } });
  },

  async runAI(task, opts) {
    try {
      set({ enrichJob: await startAIJob(task, opts) });
      get().watchAI();
    } catch (err) {
      set({ enrichJob: { state: "error", task, error: err instanceof Error ? err.message : String(err) } });
    }
  },
  async cancelAI() {
    try {
      set({ enrichJob: await cancelEnrichJob() });
    } catch {
      /* status poll will catch up */
    }
  },
  watchAI() {
    if (aiTimer) return;
    const tick = async () => {
      let job: EnrichJob;
      try {
        job = await fetchEnrichStatus();
      } catch {
        aiTimer = null;
        return;
      }
      const was = get().enrichJob.state;
      set({ enrichJob: job });
      if (job.state === "running") {
        aiTimer = setTimeout(() => void tick(), 1500);
        return;
      }
      aiTimer = null;
      // Finished while we watched: reload so the new domains show up.
      if (was === "running" && job.state === "done") {
        if (job.task === "audit") set({ audit: await fetchAudit().catch(() => null) });
        if (job.task === "review") set({ review: await fetchReview().catch(() => null) });
        // A post-merge review also fixes what it found (job.fixAll).
        if (job.task === "remediate" || job.task === "architecture" || job.fixAll) await get().refreshRemediation(); // Fix changed files: reload below
        await reloadGraph();
      }
    };
    aiTimer = setTimeout(() => void tick(), 400);
  },
  async refreshRemediation() {
    try {
      const r = await fetchRemediation();
      set({ remediation: r.records, remediationEstimates: r.estimates, wontFix: r.wontFix ?? [], fixable: { batch: r.healthBatch, items: r.healthItems, plans: r.fixAll } });
      void get().refreshPush();
    } catch {
      /* not served (static export) */
    }
  },
  async toggleWontFix(id, on) {
    const prev = get().wontFix;
    set({ wontFix: on ? [...prev, id] : prev.filter((x) => x !== id) });
    try {
      set({ wontFix: await setWontFix(id, on) });
    } catch (err) {
      set({ wontFix: prev, fixOp: { busy: false, error: err instanceof Error ? err.message : String(err) } });
    }
  },
  async reloadProject() {
    await reloadGraph();
    await get().refreshRemediation();
  },
  async refreshPush() {
    if (!get().meta?.canPush) return set({ push: null });
    try {
      const push = await fetchPushState();
      set({ push });
      // The server marks fixes from a merged pull request as it answers, after the records above were read.
      const unmerged = Object.values(get().remediation).some((r) => r?.fixes.some((f) => f.status === "applied" && f.mergedIn === undefined));
      if (push?.pr?.state === "merged" && unmerged) set({ remediation: (await fetchRemediation()).records });
    } catch {
      set({ push: null });
    }
  },
  async applyFixes(source, ids) {
    set({ fixOp: { busy: true, error: null } });
    try {
      const r = await applyRemediation(source, ids);
      set({ fixOp: { busy: false, error: r.failed.length ? r.failed.map((f) => f.error).join("; ") : null } });
      await get().refreshRemediation();
      if (r.applied.length) await reloadGraph();
    } catch (err) {
      set({ fixOp: { busy: false, error: err instanceof Error ? err.message : String(err) } });
    }
  },
  async undoFix(source, id) {
    set({ fixOp: { busy: true, error: null } });
    try {
      await undoRemediation(source, id);
      set({ fixOp: { busy: false, error: null } });
      await get().refreshRemediation();
      await reloadGraph();
    } catch (err) {
      set({ fixOp: { busy: false, error: err instanceof Error ? err.message : String(err) } });
    }
  },
  async pickProject() {
    if (get().projectOp.busy) return;
    set({ projectOp: { busy: "picking", error: null } });
    try {
      // The server scans right after the dialog closes; show that once we're still waiting.
      const t = setTimeout(() => get().projectOp.busy && set({ projectOp: { busy: "scanning", error: null } }), 1500);
      const r = await pickProjectFolder();
      clearTimeout(t);
      if ("cancelled" in r) return set({ projectOp: { busy: null, error: null } });
      await switchedTo(r.root);
    } catch (err) {
      set({ projectOp: { busy: null, error: err instanceof Error ? err.message : String(err) } });
    }
  },
  async openProject(path) {
    if (get().projectOp.busy) return;
    set({ projectOp: { busy: "scanning", error: null } });
    try {
      const r = await openProjectPath(path);
      await switchedTo(r.root);
    } catch (err) {
      set({ projectOp: { busy: null, error: err instanceof Error ? err.message : String(err) } });
    }
  },
  setModal(m) {
    set({ modal: m, menuOpen: false });
  },
  setMenu(open) {
    set({ menuOpen: open });
  },
  requestFocus(ids) {
    set({ focus: { ids, nonce: (get().focus?.nonce ?? 0) + 1 } });
  },
  requestFit() {
    set({ fitNonce: get().fitNonce + 1 });
  },
  focusSearch() {
    set({ searchFocusNonce: get().searchFocusNonce + 1, menuOpen: false });
  },
  /** Esc: close the top-most thing. */
  clearTransient() {
    const s = get();
    if (s.modal) return set({ modal: null });
    if (s.menuOpen) return set({ menuOpen: false });
    if (s.code.full) return set({ code: { ...s.code, full: false } });
    if (s.code.open) return set({ code: { ...s.code, open: false } });
    if (s.pathState.path) return set({ pathState: { ...s.pathState, path: null } });
    if (s.searchHighlight) return set({ searchHighlight: null });
    if (s.selectedFinding) return set({ selectedFinding: null });
    if (s.tour.active) return set({ tour: { ...s.tour, active: false } });
    if (s.layerIsolate) return set({ layerIsolate: null });
    if (s.selectedId) return s.select(null);
  },
  dismiss(which) {
    set({ dismissed: { ...get().dismissed, [which]: true } });
  },
}));

async function switchedTo(root: string): Promise<void> {
  rememberProject(root);
  clearFileCache();
  useStore.setState({ ...PROJECT_RESET, modal: null, projectOp: { busy: null, error: null }, enrichJob: { state: "idle" }, audit: null, review: null, remediation: {}, wontFix: [], push: null, remediateConfirm: null });
  await useStore.getState().init();
}

let aiTimer: ReturnType<typeof setTimeout> | null = null;

/** Re-fetch the graph for the same project, keeping the current view. */
async function reloadGraph(): Promise<void> {
  const { view, modal } = useStore.getState();
  await useStore.getState().init();
  useStore.setState({ view, modal });
}
