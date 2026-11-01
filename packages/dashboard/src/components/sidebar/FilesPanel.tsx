import { useMemo, useState } from "react";
import { useStore } from "../../store";
import { buildFileTree, type TreeNode } from "../../utils/tree";
import { isUnder } from "../../utils/model";
import { useModel } from "../../views/hooks";
import { IconChevronRight, IconFile, IconFolder } from "../icons";
import { RiskDot, cx } from "../ui";

export function FilesPanel() {
  const model = useModel();
  const tree = useMemo(() => buildFileTree(model.files), [model]);
  const [q, setQ] = useState("");
  const filtered = useMemo(() => {
    if (!q.trim()) return tree;
    const needle = q.toLowerCase();
    return buildFileTree(model.files.filter((f) => f.path.toLowerCase().includes(needle)));
  }, [q, tree, model]);
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-line px-3 py-2">
        <label className="sr-only" htmlFor="lens-file-filter">
          Filter files
        </label>
        <input
          id="lens-file-filter"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={`Filter ${model.files.length} files…`}
          className="h-8 w-full rounded-md border border-line bg-panel-2 px-2.5 text-[12.5px] outline-none placeholder:text-faint focus:border-accent"
        />
      </div>
      <div className="min-h-0 flex-1 overflow-auto py-1.5" role="tree" aria-label="Files">
        {filtered.children.map((c) => (
          <TreeItem key={c.path + c.name} node={c} depth={0} forceOpen={!!q.trim()} />
        ))}
        {!filtered.children.length && <p className="px-4 py-3 text-[12px] text-muted">No files match.</p>}
      </div>
    </div>
  );
}

function TreeItem({ node, depth, forceOpen }: { node: TreeNode; depth: number; forceOpen: boolean }) {
  const model = useModel();
  const selectedId = useStore((s) => s.selectedId);
  const navigateTo = useStore((s) => s.navigateTo);
  const setDir = useStore((s) => s.setDir);
  const setView = useStore((s) => s.setView);
  const selectedPath = selectedId ? model.fileById.get(model.owner.get(selectedId) ?? "")?.path : undefined;
  const [open, setOpen] = useState(() => depth < 1 || (!!selectedPath && isUnder(selectedPath, node.path)));
  const pad = { paddingLeft: 8 + depth * 14 };
  if (node.id) {
    const active = model.owner.get(selectedId ?? "") === node.id;
    return (
      <button
        type="button"
        role="treeitem"
        aria-selected={active}
        style={pad}
        onClick={() => navigateTo(node.id!)}
        className={cx("flex w-full items-center gap-1.5 py-[3px] pr-3 text-left text-[12.5px] hover:bg-raised", active && "bg-accent-soft text-accent")}
      >
        <span className="w-3" />
        <IconFile size={13} className="shrink-0 text-faint" />
        <span className="min-w-0 flex-1 truncate">{node.name}</span>
        <RiskDot severity={model.riskByFile.get(node.id)} />
      </button>
    );
  }
  const isOpen = forceOpen || open;
  return (
    <div role="treeitem" aria-expanded={isOpen} aria-selected={false}>
      <div className="group flex items-center" style={pad}>
        <button type="button" onClick={() => setOpen(!isOpen)} className="flex min-w-0 flex-1 items-center gap-1.5 py-[3px] text-left text-[12.5px] hover:text-fg" aria-label={`${isOpen ? "Collapse" : "Expand"} ${node.name}`}>
          <IconChevronRight size={12} className={cx("shrink-0 text-faint transition-transform", isOpen && "rotate-90")} />
          <IconFolder size={13} className="shrink-0 text-accent/80" />
          <span className="min-w-0 flex-1 truncate">{node.name}</span>
        </button>
        <button
          type="button"
          className="mr-2 rounded px-1.5 font-mono text-[10.5px] text-faint opacity-70 hover:bg-raised hover:text-fg group-hover:opacity-100"
          title="Show this folder in Structure view"
          aria-label={`Open ${node.path} in Structure view`}
          onClick={() => {
            setView("structure");
            setDir(node.path);
          }}
        >
          {node.fileCount}
        </button>
      </div>
      {isOpen && (
        <div role="group">
          {node.children.map((c) => (
            <TreeItem key={c.path + c.name} node={c} depth={depth + 1} forceOpen={forceOpen} />
          ))}
        </div>
      )}
    </div>
  );
}
