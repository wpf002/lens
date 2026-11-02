import { useEffect, useState } from "react";
import { authMode, signIn } from "../api";
import { useStore } from "../store";
import { IconLock, LensMark } from "./icons";
import { Button } from "./ui";

const inputCls =
  "mt-1.5 h-9 w-full rounded-md border border-line bg-panel-2 px-2.5 text-[13px] outline-none focus:border-accent";

export function TokenGate() {
  const submit = useStore((s) => s.submitToken);
  const [login, setLogin] = useState<boolean | null>(null);
  const [token, setToken] = useState("");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void authMode().then((m) => setLogin(m.login));
  }, []);

  if (login === null) return null;

  return (
    <div className="flex h-full items-center justify-center p-4">
      <form
        className="w-full max-w-md rounded-xl border border-line bg-panel p-6 shadow-[var(--shadow)]"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await submit(login ? await signIn(username.trim(), password) : token);
          } catch (err) {
            setError(err instanceof Error ? err.message : String(err));
          }
          setBusy(false);
        }}
      >
        <div className="flex items-center gap-2">
          <LensMark size={22} />
          <span className="font-serif text-[20px]">Lens</span>
        </div>
        {login ? (
          <>
            <h1 className="mt-5 text-[15px] font-medium text-fg">Sign In</h1>
            <label htmlFor="lens-user" className="eyebrow mt-4 block">
              Username
            </label>
            <input
              id="lens-user"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
              spellCheck={false}
              autoFocus
              className={inputCls}
            />
            <label htmlFor="lens-pass" className="eyebrow mt-3 block">
              Password
            </label>
            <input
              id="lens-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="current-password"
              className={inputCls}
            />
          </>
        ) : (
          <>
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
              className={`${inputCls} font-mono text-[12.5px]`}
              placeholder="paste token"
            />
          </>
        )}
        {error && <p className="mt-3 text-[12.5px] text-critical">{error}</p>}
        <Button
          type="submit"
          variant="accent"
          className="mt-4 w-full"
          disabled={busy || (login ? !username.trim() || !password : !token.trim())}
        >
          {busy ? "Checking…" : login ? "Sign In" : "Unlock Dashboard"}
        </Button>
      </form>
    </div>
  );
}
