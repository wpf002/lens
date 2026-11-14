import { useStore } from "../store";
import { VIEW_LABEL, VIEW_ORDER } from "../types";
import { Mascot } from "./Mascot";
import { Button, Kbd, Modal } from "./ui";

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

export function HelpModal() {
  const close = () => useStore.getState().setModal(null);
  const rows: Array<[string[], string]> = [
    [["/"], "Focus search"],
    [[isMac ? "⌘" : "Ctrl", "K"], "Focus search"],
    [["↑", "↓", "↵"], "Move through results / open"],
    [["1", "–", String(VIEW_ORDER.length)], VIEW_ORDER.map((v) => VIEW_LABEL[v]).join(" · ")],
    [["f"], "Fit graph to screen"],
    [["←", "→"], "Previous / next tour step (while touring)"],
    [["Esc"], "Close dialogs, clear highlight, deselect"],
    [["?"], "This help"],
  ];
  return (
    <Modal title="Keyboard Shortcuts" onClose={close}>
      <dl className="divide-y divide-line">
        {rows.map(([keys, what]) => (
          <div key={what + keys.join()} className="flex items-center justify-between gap-4 py-2">
            <dt className="flex shrink-0 items-center gap-1">
              {keys.map((k) => (k === "–" ? <span key={k} className="text-faint">–</span> : <Kbd key={k}>{k}</Kbd>))}
            </dt>
            <dd className="text-right text-[12.5px] text-muted">{what}</dd>
          </div>
        ))}
      </dl>
      <div className="mt-4 rounded-md border border-line bg-panel-2 px-3 py-2.5 text-[12px] leading-relaxed text-muted">
        <p>
          <span className="text-fg">Structure:</span> double-click a folder to open it, use <span className="font-mono text-fg">+</span> on a file to reveal its functions and classes.
        </p>
        <p className="mt-1">
          <span className="text-fg">Edges</span> are aggregated: thicker lines mean more underlying imports/calls. Hover one to see its kinds.
        </p>
      </div>
      <div className="mt-4 flex items-center gap-3">
        <Mascot size={40} />
        <span className="flex-1 text-[12px] text-muted">Want the big picture again?</span>
        <Button size="sm" onClick={() => useStore.getState().setModal("welcome")}>
          Replay the Intro
        </Button>
      </div>
    </Modal>
  );
}
