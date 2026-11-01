import { useEffect, useState } from "react";
import { Banners } from "./components/Banners";
import { CodeDrawer } from "./components/CodeDrawer";
import { FiltersModal } from "./components/FiltersModal";
import { FocusBar } from "./components/FocusBar";
import { HelpModal } from "./components/HelpModal";
import { LensMark } from "./components/icons";
import { PathFinder } from "./components/PathFinder";
import { Sidebar } from "./components/Sidebar";
import { TokenGate } from "./components/TokenGate";
import { TopBar } from "./components/TopBar";
import { Mascot } from "./components/Mascot";
import { Welcome } from "./components/Welcome";
import { Button, Spinner } from "./components/ui";
import { useStore } from "./store";
import { ProjectModal } from "./components/ProjectModal";
import { useKeyboard } from "./useKeyboard";
import { DomainView } from "./views/DomainView";
import { KnowledgeView } from "./views/KnowledgeView";
import { LayersView } from "./views/LayersView";
import { HealthView } from "./views/HealthView";
import { SecurityView } from "./views/SecurityView";
import { StructureView } from "./views/StructureView";

function useWidth(): number {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const on = () => setW(window.innerWidth);
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, []);
  return w;
}

function Shell() {
  const view = useStore((s) => s.view);
  const modal = useStore((s) => s.modal);
  const width = useWidth();
  const compact = width < 900;
  const narrow = width < 768;
  useKeyboard();
  return (
    <div className="flex h-full flex-col overflow-hidden">
      <TopBar compact={compact} />
      <Banners />
      <div className="relative flex min-h-0 flex-1">
        <main className="relative min-w-0 flex-1 overflow-hidden" aria-label={`${view} view`}>
          {view === "structure" && <StructureView />}
          {view === "layers" && <LayersView />}
          {view === "domain" && <DomainView />}
          {view === "security" && <SecurityView />}
          {view === "health" && <HealthView />}
          {view === "knowledge" && <KnowledgeView />}
          {view !== "security" && view !== "health" && <FocusBar />}
          <CodeDrawer />
        </main>
        <Sidebar narrow={narrow} />
      </div>
      {modal === "help" && <HelpModal />}
      {modal === "filters" && <FiltersModal />}
      {modal === "path" && <PathFinder />}
      {modal === "welcome" && <Welcome />}
      {modal === "project" && <ProjectModal />}
    </div>
  );
}

export function App() {
  const status = useStore((s) => s.status);
  const error = useStore((s) => s.error);
  const init = useStore((s) => s.init);
  useEffect(() => {
    void init();
  }, [init]);
  // Pasting the `lens serve` URL (with #token=...) into an already-open tab re-authenticates.
  useEffect(() => {
    const onHash = () => {
      if (/(?:^#|&)token=/.test(window.location.hash)) void init();
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [init]);

  if (status === "loading") {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-4 text-muted">
        <Mascot size={88} className="lens-float" />
        <div className="lens-scanbar" aria-hidden />
        <div className="flex items-center gap-2 text-[12.5px]">
          <Spinner size={14} /> Iris is reading the knowledge graph…
        </div>
      </div>
    );
  }
  if (status === "unauthorized") return <TokenGate />;
  if (status === "error") {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <div className="max-w-md rounded-xl border border-line bg-panel p-6">
          <div className="flex items-center gap-2">
            <LensMark size={22} />
            <h1 className="font-serif text-[19px]">Couldn't load the graph</h1>
          </div>
          <p className="mt-3 break-words font-mono text-[12px] text-muted">{error}</p>
          <p className="mt-3 text-[12.5px] text-muted">
            Start the dashboard with <code className="font-mono text-fg">lens serve</code>, or export a static copy with <code className="font-mono text-fg">lens export --format html</code>.
          </p>
          <Button className="mt-4" onClick={() => void init()}>
            Retry
          </Button>
        </div>
      </div>
    );
  }
  return <Shell />;
}
