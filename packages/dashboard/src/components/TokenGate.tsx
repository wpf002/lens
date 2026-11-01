import { useState } from "react";
import { useStore } from "../store";
import { IconLock, LensMark } from "./icons";
import { Button } from "./ui";

export function TokenGate() {
  const submit = useStore((s) => s.submitToken);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex h-full items-center justify-center p-4">
      <form
        className="w-full max-w-md rounded-xl border border-line bg-panel p-6 shadow-[var(--shadow)]"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await submit(token);
          setBusy(false);
        }}
      >
        <div className="flex items-center gap-2">
          <LensMark size={22} />
          <span className="font-serif text-[20px]">Lens</span>
        </div>
        <div className="mt-5 flex items-center gap-2 text-fg">
          <IconLock size={16} className="text-accent" />
          <h1 className="text-[15px] font-medium">This dashboard needs its access token</h1>
        </div>
        <p className="mt-2 text-[12.5px] leading-relaxed text-muted">
          <code className="font-mono text-fg">lens serve</code> prints a URL ending in <code className="font-mono text-fg">#token=…</code>. Reopen that exact URL, or paste the token below. It is kept for this tab only.
        </p>
        <label htmlFor="lens-token" className="eyebrow mt-4 block">
          Token
        </label>
        <input
          id="lens-token"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          autoComplete="off"
          spellCheck={false}
          autoFocus
          className="mt-1.5 h-9 w-full rounded-md border border-line bg-panel-2 px-2.5 font-mono text-[12.5px] outline-none focus:border-accent"
          placeholder="paste token"
        />
        <Button type="submit" variant="accent" className="mt-4 w-full" disabled={!token.trim() || busy}>
          {busy ? "Checking…" : "Unlock dashboard"}
        </Button>
      </form>
    </div>
  );
}
