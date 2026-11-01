import type { ReactNode } from "react";
import { useStore } from "../store";
import { IconAlert, IconX } from "./icons";

function Banner({ tone, children, onDismiss }: { tone: "warn" | "info"; children: ReactNode; onDismiss: () => void }) {
  return (
    <div
      role="status"
      className="flex shrink-0 items-start gap-2 border-b px-4 py-1.5 text-[12px]"
      style={{
        borderColor: "var(--border)",
        background: tone === "warn" ? "color-mix(in srgb, var(--sev-high) 10%, var(--panel))" : "color-mix(in srgb, var(--accent) 9%, var(--panel))",
      }}
    >
      <IconAlert size={14} className="mt-[1px] shrink-0" style={{ color: tone === "warn" ? "var(--sev-high)" : "var(--accent)" }} />
      <div className="min-w-0 flex-1">{children}</div>
      <button type="button" aria-label="Dismiss" onClick={onDismiss} className="rounded p-0.5 text-muted hover:text-fg">
        <IconX size={13} />
      </button>
    </div>
  );
}

export function Banners() {
  const warnings = useStore((s) => s.warnings);
  const model = useStore((s) => s.model);
  const dismissed = useStore((s) => s.dismissed);
  const dismiss = useStore((s) => s.dismiss);
  const canEnrich = useStore((s) => s.mode === "server" && !!s.meta?.canEnrich);
  return (
    <>
      {warnings.length > 0 && !dismissed.warnings && (
        <Banner tone="warn" onDismiss={() => dismiss("warnings")}>
          <span className="font-medium">This graph doesn't fully match the lens/1 schema.</span>{" "}
          <span className="text-muted">{warnings.slice(0, 3).join(" ")}{warnings.length > 3 ? ` (+${warnings.length - 3} more)` : ""} Rendering what we can.</span>
        </Banner>
      )}
      {!!model?.staleCount && !dismissed.stale && (
        <Banner tone="info" onDismiss={() => dismiss("stale")}>
          <span className="font-medium">{model.staleCount} summar{model.staleCount === 1 ? "y is" : "ies are"} out of date.</span>
          <span className="text-muted">
            {canEnrich ? (
              " Use Summarize with AI in the Overview to refresh them."
            ) : (
              <>
                {" "}Run <code className="font-mono text-fg">/lens</code> in Claude Code to refresh them.
              </>
            )}
          </span>
        </Banner>
      )}
    </>
  );
}
