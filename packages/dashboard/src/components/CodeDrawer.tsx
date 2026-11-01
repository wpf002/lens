import { useEffect, useRef, useState } from "react";
import { Highlight, Prism, type PrismTheme } from "prism-react-renderer";
import { fetchFile, SourceUnavailableError, UnauthorizedError, type FilePayload } from "../api";
import { useStore } from "../store";
import { IconCode, IconCollapse, IconExpand, IconX } from "./icons";
import { IconButton, Spinner, cx } from "./ui";

const theme: PrismTheme = {
  plain: { color: "var(--fg)", backgroundColor: "transparent" },
  styles: [
    { types: ["comment", "prolog", "doctype", "cdata"], style: { color: "var(--code-comment)", fontStyle: "italic" } },
    { types: ["keyword", "atrule", "important", "rule"], style: { color: "var(--code-keyword)" } },
    { types: ["string", "char", "attr-value", "regex", "inserted"], style: { color: "var(--code-string)" } },
    { types: ["number", "boolean", "constant", "symbol"], style: { color: "var(--code-number)" } },
    { types: ["function", "method"], style: { color: "var(--code-function)" } },
    { types: ["class-name", "builtin", "type", "maybe-class-name"], style: { color: "var(--code-type)" } },
    { types: ["tag", "selector", "deleted"], style: { color: "var(--code-tag)" } },
    { types: ["attr-name", "property"], style: { color: "var(--code-function)" } },
    { types: ["punctuation", "operator"], style: { color: "var(--code-punct)" } },
  ],
};

const LANG_ALIASES: Record<string, string> = {
  typescript: "tsx", ts: "tsx", tsx: "tsx", javascript: "jsx", js: "jsx", jsx: "jsx", mjs: "jsx", cjs: "jsx",
  python: "python", py: "python", go: "go", rust: "rust", rs: "rust", json: "json", yaml: "yaml", yml: "yaml",
  markdown: "markdown", md: "markdown", sql: "sql", css: "css", html: "markup", xml: "markup", svg: "markup",
  c: "c", cpp: "cpp", "c++": "cpp", swift: "swift", kotlin: "kotlin", graphql: "graphql", objc: "objectivec",
};

function prismLang(lang: string | undefined, path: string): string {
  const key = (lang || path.split(".").pop() || "").toLowerCase();
  const l = LANG_ALIASES[key] ?? key;
  return l in Prism.languages ? l : "plain";
}

type Load = { status: "loading" } | { status: "ok"; file: FilePayload } | { status: "error"; message: string; unavailable?: boolean };

export function CodeDrawer() {
  const code = useStore((s) => s.code);
  const mode = useStore((s) => s.mode);
  const close = useStore((s) => s.closeCode);
  const toggleFull = useStore((s) => s.toggleCodeFull);
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const focusRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!code.open || !code.path) return;
    let cancelled = false;
    setLoad({ status: "loading" });
    fetchFile(mode, code.path)
      .then((file) => !cancelled && setLoad({ status: "ok", file }))
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof UnauthorizedError) useStore.setState({ status: "unauthorized" });
        setLoad({ status: "error", message: e instanceof Error ? e.message : String(e), unavailable: e instanceof SourceUnavailableError });
      });
    return () => {
      cancelled = true;
    };
  }, [code.open, code.path, mode]);

  useEffect(() => {
    if (load.status !== "ok") return;
    const t = requestAnimationFrame(() => focusRef.current?.scrollIntoView({ block: "center" }));
    return () => cancelAnimationFrame(t);
  }, [load, code.focusLine, code.lines, code.full]);

  if (!code.open || !code.path) return null;
  const [a, b] = code.lines ?? [code.focusLine ?? 0, code.focusLine ?? 0];
  const focusLine = code.focusLine ?? a;

  const body = (
    <>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        <IconCode size={14} className="shrink-0 text-accent" />
        <span className="min-w-0 truncate font-mono text-[12px]" title={code.path}>
          <span className="text-muted">{code.path.split("/").slice(0, -1).join("/")}/</span>
          {code.path.split("/").pop()}
        </span>
        {a > 0 && (
          <span className="shrink-0 font-mono text-[11px] text-muted">
            L{a}
            {b > a ? `–${b}` : ""}
          </span>
        )}
        {code.title && <span className="hidden min-w-0 truncate text-[12px] text-muted sm:inline">· {code.title}</span>}
        <div className="ml-auto flex shrink-0 items-center">
          <IconButton label={code.full ? "Exit full screen" : "Full screen"} onClick={toggleFull}>
            {code.full ? <IconCollapse size={14} /> : <IconExpand size={14} />}
          </IconButton>
          <IconButton label="Close code viewer (Esc)" onClick={close}>
            <IconX size={15} />
          </IconButton>
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto" style={{ background: "var(--code-bg)" }}>
        {load.status === "loading" && (
          <div className="flex h-full items-center justify-center gap-2 text-[12px] text-muted">
            <Spinner size={14} /> Loading source…
          </div>
        )}
        {load.status === "error" && (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="text-[13px] text-fg">{load.unavailable ? load.message : "Could not load this file"}</p>
            <p className="max-w-md text-[12px] text-muted">
              {load.unavailable ? (
                <>
                  Open the dashboard with <code className="font-mono text-fg">lens serve</code> to browse source. Location: <span className="font-mono">{code.path}{a ? `:${a}` : ""}</span>
                </>
              ) : (
                load.message
              )}
            </p>
          </div>
        )}
        {load.status === "ok" && (
          <Highlight code={load.file.content.replace(/\n$/, "")} language={prismLang(load.file.language, load.file.path)} theme={theme}>
            {({ tokens, getLineProps, getTokenProps }) => (
              <pre className="min-w-max py-2 font-mono text-[12px] leading-[1.6]">
                {tokens.map((line, i) => {
                  const n = i + 1;
                  const inRange = a > 0 && n >= a && n <= b;
                  const lp = getLineProps({ line });
                  return (
                    <div key={i} ref={n === focusLine ? focusRef : undefined} {...lp} className={cx("flex pr-6", inRange && "bg-[var(--code-line)]")}>
                      <span className={cx("sticky left-0 w-12 shrink-0 select-none pr-3 text-right tabular", inRange ? "text-accent" : "text-faint")} style={{ background: inRange ? "transparent" : "var(--code-bg)" }} aria-hidden>
                        {n}
                      </span>
                      <span className={cx("border-l-2 pl-3", inRange ? "border-accent" : "border-transparent")}>
                        {line.map((token, k) => (
                          <span key={k} {...getTokenProps({ token })} />
                        ))}
                        {line.length === 1 && line[0]!.empty ? "\n" : null}
                      </span>
                    </div>
                  );
                })}
              </pre>
            )}
          </Highlight>
        )}
      </div>
    </>
  );

  if (code.full) {
    return (
      <div className="fixed inset-0 z-50 flex bg-black/55 p-2 sm:p-6" onMouseDown={(e) => e.target === e.currentTarget && toggleFull()}>
        <div role="dialog" aria-modal="true" aria-label={`Source of ${code.path}`} className="lens-rise flex min-h-0 w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[var(--shadow)]">
          {body}
        </div>
      </div>
    );
  }
  return (
    <section aria-label="Source code" className="lens-rise absolute inset-x-0 bottom-0 z-20 flex h-[44%] min-h-[200px] flex-col border-t border-line bg-panel shadow-[0_-12px_32px_rgba(0,0,0,0.35)]">
      {body}
    </section>
  );
}
