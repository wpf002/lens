import type { FileInfo } from "./model";

export interface TreeNode {
  name: string;
  path: string;
  /** file node id for leaves */
  id?: string;
  kind?: FileInfo["kind"];
  children: TreeNode[];
  fileCount: number;
}

/** Build a directory tree from file paths; single-child directory chains are compacted ("src/server"). */
export function buildFileTree(files: FileInfo[]): TreeNode {
  const root: TreeNode = { name: "", path: "", children: [], fileCount: 0 };
  const dirMap = new Map<string, TreeNode>([["", root]]);
  const ensure = (dir: string): TreeNode => {
    const hit = dirMap.get(dir);
    if (hit) return hit;
    const i = dir.lastIndexOf("/");
    const parent = ensure(i < 0 ? "" : dir.slice(0, i));
    const node: TreeNode = { name: i < 0 ? dir : dir.slice(i + 1), path: dir, children: [], fileCount: 0 };
    parent.children.push(node);
    dirMap.set(dir, node);
    return node;
  };
  for (const f of files) {
    const d = ensure(f.dir);
    d.children.push({ name: f.name, path: f.path, id: f.id, kind: f.kind, children: [], fileCount: 1 });
  }
  const finish = (n: TreeNode): number => {
    if (n.id) return 1;
    n.children.sort((a, b) => Number(!!a.id) - Number(!!b.id) || a.name.localeCompare(b.name));
    n.fileCount = n.children.reduce((a, c) => a + finish(c), 0);
    // compact chains
    n.children = n.children.map((c) => {
      let cur = c;
      while (!cur.id && cur.children.length === 1 && !cur.children[0]!.id) {
        const only = cur.children[0]!;
        cur = { ...only, name: `${cur.name}/${only.name}` };
      }
      return cur;
    });
    return n.fileCount;
  };
  finish(root);
  return root;
}
