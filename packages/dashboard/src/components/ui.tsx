import { useEffect, useRef, type ButtonHTMLAttributes, type KeyboardEvent, type ReactNode } from "react";
import type { NodeKind, Severity } from "@lens/core/browser";
import { KIND_LABEL, SEVERITY_COLOR } from "../utils/colors";
import { IconX } from "./icons";
import { Mascot } from "./Mascot";

export function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

type BtnProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "ghost" | "solid" | "outline" | "accent";
  size?: "sm" | "md";
  active?: boolean;
};

export function Button({ variant = "outline", size = "md", active, className, children, ...rest }: BtnProps) {
  return (
    <button
      type="button"
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-1.5 rounded-md font-medium whitespace-nowrap transition-colors select-none",
        size === "sm" ? "h-7 px-2 text-[12px]" : "h-8 px-2.5 text-[12.5px]",
        variant === "ghost" && "text-muted hover:text-fg hover:bg-raised",
        variant === "outline" && "border border-line text-fg bg-panel hover:border-line-strong hover:bg-raised",
        variant === "solid" && "bg-raised text-fg hover:bg-line",
        variant === "accent" && "bg-accent text-accent-fg hover:brightness-110",
        active && variant !== "accent" && "!border-accent !text-accent bg-accent-soft",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function IconButton({ label, active, className, children, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      {...rest}
      className={cx(
        "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md text-muted transition-colors hover:text-fg hover:bg-raised",
        active && "text-accent bg-accent-soft hover:text-accent",
        className,
      )}
    >
      {children}
    </button>
  );
}

export function KindBadge({ kind, className }: { kind?: NodeKind; className?: string }) {
  if (!kind) return null;
  return (
    <span
      className={cx(
        "inline-flex h-[16px] shrink-0 items-center rounded-[4px] border border-line px-1 font-mono text-[9.5px] font-medium uppercase leading-none tracking-wide text-muted",
        className,
      )}
    >
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

export function SeverityBadge({ severity, className }: { severity: Severity; className?: string }) {
  return (
    <span
      className={cx("inline-flex h-[18px] items-center gap-1 rounded-[4px] px-1.5 text-[10.5px] font-semibold uppercase tracking-wide", className)}
      style={{ color: SEVERITY_COLOR[severity], background: `color-mix(in srgb, ${SEVERITY_COLOR[severity]} 14%, transparent)` }}
    >
      {severity}
    </span>
  );
}

export function RiskDot({ severity, title }: { severity?: Severity; title?: string }) {
  if (!severity) return null;
  return (
    <span
      role="img"
      aria-label={title ?? `${severity} finding`}
      title={title ?? `${severity} finding`}
      className="inline-block h-2 w-2 shrink-0 rounded-full"
      style={{ background: SEVERITY_COLOR[severity], boxShadow: `0 0 0 3px color-mix(in srgb, ${SEVERITY_COLOR[severity]} 22%, transparent)` }}
    />
  );
}

export function Chip({ children, className, onClick, title }: { children: ReactNode; className?: string; onClick?: () => void; title?: string }) {
  const cls = cx("inline-flex items-center gap-1 rounded-full border border-line bg-panel-2 px-2 py-[1px] text-[11px] text-muted", onClick && "hover:text-fg hover:border-line-strong", className);
  return onClick ? (
    <button type="button" className={cls} onClick={onClick} title={title}>
      {children}
    </button>
  ) : (
    <span className={cls} title={title}>
      {children}
    </span>
  );
}

export function Spinner({ size = 16, label = "Loading" }: { size?: number; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className="lens-spin" role="status" aria-label={label}>
      <circle cx="12" cy="12" r="9" fill="none" stroke="var(--border-strong)" strokeWidth="2.5" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="var(--accent)" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

export function EmptyState({ title, body, icon, action }: { title: string; body: ReactNode; icon?: ReactNode; action?: ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6">
      <div className="max-w-md text-center">
        {icon ? (
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-full border border-line text-accent">{icon}</div>
        ) : (
          <Mascot size={72} className="lens-float mx-auto mb-3" />
        )}
        <h2 className="font-serif text-[20px] text-fg">{title}</h2>
        <div className="mt-2 text-[13px] leading-relaxed text-muted">{typeof body === "string" ? renderInlineCode(body) : body}</div>
        {action && <div className="mt-4">{action}</div>}
      </div>
    </div>
  );
}

/** Render `backticks` as inline code; everything else as text. */
export function renderInlineCode(text: string): ReactNode {
  if (!text) return null;
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? (
      <code key={i} className="rounded bg-raised px-1 py-[1px] font-mono text-[0.92em] text-fg">
        {p.slice(1, -1)}
      </code>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export function Modal({
  title,
  onClose,
  children,
  wide,
  footer,
  labelledBy = "lens-modal-title",
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  wide?: boolean;
  footer?: ReactNode;
  labelledBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const prev = document.activeElement as HTMLElement | null;
    const el = ref.current;
    const first = el?.querySelector<HTMLElement>("input, button, [tabindex]:not([tabindex='-1'])");
    first?.focus();
    return () => prev?.focus?.();
  }, []);
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== "Tab" || !ref.current) return;
    const items = [...ref.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled]), input, select, textarea, [tabindex]:not([tabindex='-1'])")];
    if (!items.length) return;
    const first = items[0]!;
    const last = items[items.length - 1]!;
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/55 p-3 pt-[8vh] backdrop-blur-[2px] sm:p-6 sm:pt-[10vh]" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        onKeyDown={onKeyDown}
        className={cx("lens-rise flex max-h-[80vh] w-full flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-[var(--shadow)]", wide ? "max-w-3xl" : "max-w-lg")}
      >
        <div className="flex items-center justify-between border-b border-line px-4 py-3">
          <h2 id={labelledBy} className="font-serif text-[17px] text-fg">
            {title}
          </h2>
          <IconButton label="Close" onClick={onClose}>
            <IconX />
          </IconButton>
        </div>
        <div className="min-h-0 flex-1 overflow-auto p-4">{children}</div>
        {footer && <div className="flex items-center justify-end gap-2 border-t border-line px-4 py-3">{footer}</div>}
      </div>
    </div>
  );
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-flex h-[18px] min-w-[18px] items-center justify-center rounded border border-line bg-panel-2 px-1 font-mono text-[10.5px] text-muted">{children}</kbd>;
}

export function Section({ title, children, right, className }: { title: string; children: ReactNode; right?: ReactNode; className?: string }) {
  return (
    <section className={cx("border-b border-line px-4 py-3.5", className)}>
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="eyebrow">{title}</h3>
        {right}
      </div>
      {children}
    </section>
  );
}
