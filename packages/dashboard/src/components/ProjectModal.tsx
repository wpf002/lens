import { useEffect, useState, type FormEvent } from "react";
import { githubConnectUrl, githubDisconnect, githubRepos, listCloudRepos, type GithubRepo } from "../api";
import { recentProjects, useStore } from "../store";
import { IconFolder } from "./icons";
import { Mascot } from "./Mascot";
import { Button, Modal, Spinner } from "./ui";

function shortPath(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

export function ProjectModal() {
  const meta = useStore((s) => s.meta);
  const op = useStore((s) => s.projectOp);
  const pick = useStore((s) => s.pickProject);
  const open = useStore((s) => s.openProject);
  const [typed, setTyped] = useState("");
  const cloud = !!meta?.cloud;
  const [repos, setRepos] = useState<string[]>([]);
  useEffect(() => {
    if (cloud) listCloudRepos().then((r) => setRepos(r.repos), () => setRepos([]));
  }, [cloud]);
  const gh = meta?.github;
  const [ghLogin, setGhLogin] = useState<string | null>(gh?.login ?? null);
  const [ghRepos, setGhRepos] = useState<GithubRepo[]>([]);
  const [ghError, setGhError] = useState<string | null>(null);
  useEffect(() => {
    if (cloud && ghLogin) githubRepos().then((r) => setGhRepos(r.repos), (e: Error) => setGhError(e.message));
  }, [cloud, ghLogin]);
  const connect = async () => {
    try {
      window.location.href = (await githubConnectUrl()).url;
    } catch (e) {
      setGhError(e instanceof Error ? e.message : String(e));
    }
  };
  const disconnect = async () => {
    await githubDisconnect().catch(() => undefined);
    setGhLogin(null);
    setGhRepos([]);
  };
  const q = typed.trim().toLowerCase();
  const ghShown = ghRepos.filter((r) => r.name !== meta?.repo && (!q || r.name.toLowerCase().includes(q))).slice(0, 8);
  const recents = cloud ? repos.filter((r) => r !== meta?.repo) : recentProjects().filter((r) => r !== meta?.root);
  const busy = op.busy !== null;
  const close = () => useStore.getState().setModal(null);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (typed.trim()) void open(typed.trim());
  };

  return (
    <Modal title="Open Project" onClose={close}>
      {meta?.root && (
        <p className="mb-4 text-[12px] text-muted">
          Showing <span className="font-mono text-fg">{meta.repo ?? shortPath(meta.root)}</span>
        </p>
      )}

      {busy ? (
        <div className="flex flex-col items-center gap-3 py-6 text-center">
          <Mascot size={64} className="lens-float" />
          <div className="lens-scanbar" aria-hidden />
          <div className="flex items-center gap-2 text-[12.5px] text-muted" role="status">
            <Spinner size={14} />
            {op.busy === "picking" ? "Choose a folder in the window that just opened…" : cloud ? "Cloning and scanning…" : "Scanning the project. Big repos take a few seconds…"}
          </div>
        </div>
      ) : (
        <>
          {cloud && gh?.available && (
            <div className="mb-3 flex items-center justify-between gap-2">
              {ghLogin ? (
                <>
                  <span className="text-[12px] text-muted">
                    GitHub <span className="font-mono text-fg">@{ghLogin}</span>
                  </span>
                  {!gh.app && (
                    <Button size="sm" onClick={() => void disconnect()}>
                      Disconnect
                    </Button>
                  )}
                </>
              ) : (
                <Button variant="accent" className="h-10 w-full text-[13px]" onClick={() => void connect()}>
                  Connect GitHub
                </Button>
              )}
            </div>
          )}

          {meta?.canPick !== false && (
            <Button variant="accent" className="h-10 w-full text-[13px]" autoFocus onClick={() => void pick()}>
              <IconFolder size={16} /> Choose a Folder…
            </Button>
          )}

          <form onSubmit={submit} className="mt-3 flex gap-2">
            <input
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              placeholder={cloud ? "owner/repo or GitHub URL" : "~/Documents/GitHub/my-app"}
              aria-label={cloud ? "GitHub repo" : "Folder path"}
              autoFocus={cloud}
              spellCheck={false}
              className="h-8 min-w-0 flex-1 rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12px] text-fg placeholder:text-faint focus:border-accent focus:outline-none"
            />
            <Button type="submit" disabled={!typed.trim()}>
              Open
            </Button>
          </form>

          {op.error && (
            <p className="mt-3 rounded-md border border-critical/40 bg-critical/10 px-2.5 py-2 text-[12px] text-fg" role="alert">
              {op.error}
            </p>
          )}

          {ghError && <p className="mt-3 text-[12px] text-critical">{ghError}</p>}

          {ghShown.length > 0 && (
            <div className="mt-5">
              <div className="eyebrow mb-1.5">Your Repos</div>
              <ul className="divide-y divide-line rounded-md border border-line">
                {ghShown.map((r) => (
                  <li key={r.name}>
                    <button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-raised" onClick={() => void open(r.name)}>
                      <IconFolder size={14} className="shrink-0 text-accent" />
                      <span className="shrink-0 whitespace-nowrap text-[12.5px] text-fg">{r.name.split("/").pop()}</span>
                      <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-faint">{r.name}</span>
                      {r.private && <span className="shrink-0 text-[10.5px] uppercase tracking-wide text-faint">Private</span>}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {recents.length > 0 && (
            <div className="mt-5">
              <div className="eyebrow mb-1.5">Recent</div>
              <ul className="divide-y divide-line rounded-md border border-line">
                {recents.map((r) => (
                  <li key={r}>
                    <button type="button" className="flex w-full items-center gap-2 px-2.5 py-2 text-left hover:bg-raised" onClick={() => void open(r)}>
                      <IconFolder size={14} className="shrink-0 text-accent" />
                      <span className="shrink-0 whitespace-nowrap text-[12.5px] text-fg">{r.split("/").pop()}</span>
                      <span className="min-w-0 truncate font-mono text-[11px] text-faint">{cloud ? r : shortPath(r)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}

          {!cloud && (
            <p className="mt-4 text-[11.5px] text-faint">
              Lens scans the folder and saves its graph to <span className="font-mono">.lens/</span> inside it.
            </p>
          )}
        </>
      )}
    </Modal>
  );
}
