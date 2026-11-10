import { ChevronRight, CircleAlert, CircleCheck, CircleX, Info, LoaderCircle, TriangleAlert, type LucideIcon } from "lucide-react";
import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode } from "react";
import type { Job, Severity, ValidationStatus } from "../api";
import { useEmbedded } from "../lib/embedded";
import { SeeHow } from "../features/guide/SeeHow";
import { GLOSSARY, SEVERITY, VALIDATION, jobLabel, type FriendlyError, type GlossaryWord, type Tone } from "../lib/labels";
import { RIBBON_TICK, SEVERITY_HELP, TEST_STATUS, jobHelp } from "../lib/help";
import { HelpTip, Tooltip, keyEntries, type KeyEntry, type Placement } from "./Tooltip";

/* One icon per concept, used everywhere. */
const TONE_ICON: Record<Tone, LucideIcon> = { success: CircleCheck, warning: TriangleAlert, danger: CircleX, info: Info, neutral: CircleAlert };
export const toneIcon = (t: Tone) => TONE_ICON[t];

// ── Buttons ─────────────────────────────────────────────────────────────────

type Variant = "primary" | "secondary" | "ghost" | "danger" | "link";
/** The design system's icon size per button size: 16 / 18 / 20. */
const ICON_PX = { sm: 16, md: 18, lg: 20 } as const;
interface BtnProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    variant?: Variant;
    size?: "sm" | "md" | "lg";
    icon?: LucideIcon;
    loading?: boolean;
    iconOnly?: boolean;
    /** What pressing it does (the outcome), shown as a tooltip. An `iconOnly` button shows its aria-label anyway, `tip` under it. */
    tip?: ReactNode;
    tipPlacement?: Placement;
}
const cls = (variant: Variant, size: string, iconOnly?: boolean) =>
    ["btn", variant === "primary" && "btn-primary", variant === "ghost" && "btn-ghost", variant === "link" && "btn-link", variant === "danger" && "btn-danger", size === "lg" && "btn-lg", size === "sm" && "btn-sm", iconOnly && "btn-icon"].filter(Boolean).join(" ");

/** The tooltip of an icon-only control: its name (not visible otherwise), then what it does when one is given. */
function nameAndTip(name: string | undefined, tip: ReactNode): ReactNode {
    if (!name) return tip;
    if (!tip) return name;
    return (
        <>
            <span className="tt-name">{name}</span>
            {tip}
        </>
    );
}

/** Whether a tip has something to show (Tooltip renders nothing for these). */
const hasTip = (tip: ReactNode) => !(tip === null || tip === undefined || tip === false || (typeof tip === "string" && tip.trim() === ""));

export function Button({ variant = "secondary", size = "md", icon: Icon, loading, iconOnly, children, disabled, className, tip, tipPlacement, onClick, ...rest }: BtnProps) {
    const off = Boolean(disabled || loading);
    // A disabled button with a tip usually says why it is disabled ("Save or discard your changes first"). The `disabled` attribute
    // would take it out of the tab order, so the keyboard could never reach that reason: such a button is aria-disabled instead. It
    // stays unclickable (a press does nothing, not even submit its form or reach a click handler around it) and looks the same.
    const soft = off && hasTip(tip);
    const btn = (
        <button
            className={`${cls(variant, size, iconOnly)} ${className ?? ""}`}
            disabled={off && !soft}
            {...rest}
            aria-disabled={soft ? true : rest["aria-disabled"]}
            onClick={
                soft
                    ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                      }
                    : onClick
            }
        >
            {loading ? <LoaderCircle size={ICON_PX[size]} className="spin" aria-hidden /> : Icon ? <Icon size={ICON_PX[size]} aria-hidden /> : null}
            {children}
        </button>
    );
    // An icon-only button shows its name: the icon alone may not say it. A disabled icon-only button without a tip shows nothing.
    const name = iconOnly && !off ? (rest["aria-label"] as string | undefined) : undefined;
    const content = nameAndTip(name, tip);
    return (
        <Tooltip content={content} placement={tipPlacement}>
            {btn}
        </Tooltip>
    );
}

export function LinkButton({ href, variant = "secondary", size = "md", icon: Icon, children, external, tip }: { href: string; variant?: Variant; size?: "sm" | "md" | "lg"; icon?: LucideIcon; children: ReactNode; external?: boolean; /** What following the link does; external links say they open a new tab unless given one. */ tip?: ReactNode }) {
    return (
        <Tooltip content={tip ?? (external ? "Opens in a new tab." : undefined)}>
            <a className={cls(variant, size)} href={href} {...(external ? { target: "_blank", rel: "noreferrer" } : {})}>
                {Icon && <Icon size={ICON_PX[size]} aria-hidden />}
                {children}
            </a>
        </Tooltip>
    );
}

// ── Badges ──────────────────────────────────────────────────────────────────

/**
 * `tip` (or the older `title`) is the badge's definition: shown on hover and read by screen readers as its description. A badge is
 * not a tab stop (a list of tests would get one per row); `tipFocusable` makes a lone badge one, so the keyboard can show it too.
 */
export function Badge({ tone = "neutral", icon: Icon, children, title, tip, tipFocusable }: { tone?: Tone | "brand"; icon?: LucideIcon; children: ReactNode; title?: string; tip?: ReactNode; tipFocusable?: boolean }) {
    const content = tip ?? title;
    return (
        <Tooltip content={content}>
            <span className={`badge badge-${tone}`} tabIndex={content && tipFocusable ? 0 : undefined}>
                {Icon && <Icon size={12} aria-hidden />}
                {children}
            </span>
        </Tooltip>
    );
}

export function StatusBadge({ status, tipFocusable }: { status: ValidationStatus; tipFocusable?: boolean }) {
    const v = VALIDATION[status];
    return (
        <Badge tone={v.tone} icon={status === "VALIDATING" ? LoaderCircle : toneIcon(v.tone)} tip={TEST_STATUS[status]} tipFocusable={tipFocusable}>
            {v.label}
        </Badge>
    );
}

export function SeverityBadge({ severity, basis, tipFocusable }: { severity: Severity; basis?: string; tipFocusable?: boolean }) {
    const s = SEVERITY[severity];
    const why = basis?.trim().replace(/\.$/, "");
    return (
        <Badge tone={s.tone} tip={`${SEVERITY_HELP[severity]}${why ? ` Rated from: ${why}.` : ""}`} tipFocusable={tipFocusable}>
            {s.label} severity
        </Badge>
    );
}

export function JobBadge({ job, tipFocusable }: { job: Pick<Job, "status" | "error" | "mode"> & { planOnly?: boolean; targets?: Job["targets"] }; tipFocusable?: boolean }) {
    const j = jobLabel(job);
    return (
        <Badge tone={j.tone} icon={j.tone === "info" ? LoaderCircle : toneIcon(j.tone)} tip={jobHelp(job)} tipFocusable={tipFocusable}>
            {j.label}
        </Badge>
    );
}

// The BadgeKey lines for the badges above, so a list explains exactly the words it shows (Tooltip.tsx BadgeKey).
const STATUS_ORDER: ValidationStatus[] = ["VALIDATED", "NEEDS_REVIEW", "FAILED_VALIDATION", "VALIDATING", "PENDING"];
const SEVERITY_ORDER: Severity[] = ["critical", "high", "medium", "low"];
/** StatusBadge words and definitions, for the statuses present. */
export const statusKey = (present: Iterable<ValidationStatus | null | undefined>): KeyEntry[] => keyEntries(STATUS_ORDER, present, (s) => VALIDATION[s].label, (s) => TEST_STATUS[s]);
/** SeverityBadge words and definitions, for the severities present. */
export const severityKey = (present: Iterable<Severity | null | undefined>): KeyEntry[] => keyEntries(SEVERITY_ORDER, present, (s) => `${SEVERITY[s].label} severity`, (s) => SEVERITY_HELP[s]);
/** JobBadge words and definitions, for the jobs listed (a word is explained once). */
export const jobKey = (jobs: Array<Parameters<typeof JobBadge>[0]["job"]>): KeyEntry[] => jobs.map((j) => ({ word: jobLabel(j).label, text: jobHelp(j) }));

/**
 * A word a tester may not know, with its one-sentence explanation one click (or Enter) away. Not hover-only: the explanation is a
 * button-controlled note that stays until the button is pressed again, Escape is pressed or the person clicks elsewhere.
 */
export function Term({ word, children }: { word: GlossaryWord; children?: ReactNode }) {
    const [open, setOpen] = useState(false);
    const id = useId();
    const ref = useRef<HTMLSpanElement>(null);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
        const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
        document.addEventListener("mousedown", away);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("mousedown", away);
            document.removeEventListener("keydown", esc);
        };
    }, [open]);
    return (
        <span className="term" ref={ref}>
            <button type="button" className="term-btn" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen((o) => !o)}>
                {children ?? word}
            </button>
            {open && (
                <span id={id} role="note" className="term-note">
                    {GLOSSARY[word]}
                </span>
            )}
        </span>
    );
}

// ── Messages ────────────────────────────────────────────────────────────────

export function Callout({ tone = "info", title, children, actions }: { tone?: Tone; title?: string; children?: ReactNode; actions?: ReactNode }) {
    const Icon = toneIcon(tone);
    return (
        <div className={`callout callout-${tone}`} role={tone === "danger" ? "alert" : undefined}>
            <Icon size={20} aria-hidden style={{ flex: "none", marginTop: 1 }} />
            <div className="body">
                {title && <div className="title">{title}</div>}
                {children && <p>{children}</p>}
                {actions && <div className="actions">{actions}</div>}
            </div>
        </div>
    );
}

/** `seeHow` adds the calm "Not sure how this works? See how" line, which opens that Guide topic in the Help panel. */
export function EmptyState({ icon: Icon, title, children, actions, seeHow }: { icon: LucideIcon; title: string; children?: ReactNode; actions?: ReactNode; seeHow?: { topic: string; query?: string } }) {
    return (
        <div className="empty">
            <div className="icon-wrap">
                <Icon size={22} aria-hidden />
            </div>
            <h3 className="t-section">{title}</h3>
            {children && <p>{children}</p>}
            {actions && <div className="actions">{actions}</div>}
            {seeHow && <SeeHow topic={seeHow.topic} query={seeHow.query} />}
        </div>
    );
}

/** What happened, why, and what to do. */
export function ErrorState({ error, onRetry }: { error: FriendlyError; onRetry?: () => void }) {
    return (
        <div className="card card-pad">
            <Callout
                tone="danger"
                title={error.title}
                actions={
                    <>
                        {onRetry && (
                            <Button size="sm" onClick={onRetry}>
                                Try again
                            </Button>
                        )}
                        {error.fix && <LinkButton size="sm" href={error.fix.href}>{error.fix.label}</LinkButton>}
                    </>
                }
            >
                {error.body}
            </Callout>
        </div>
    );
}

export function Skeleton({ w = "100%", h = 14, style }: { w?: number | string; h?: number; style?: React.CSSProperties }) {
    return <div className="skel" style={{ width: w, height: h, ...style }} aria-hidden />;
}

export function ListSkeleton({ rows = 4 }: { rows?: number }) {
    return (
        <div className="card divided" aria-busy="true" aria-label="Loading">
            {Array.from({ length: rows }, (_, i) => (
                <div className="list-row" key={i}>
                    <Skeleton w={32} h={32} />
                    <div className="main">
                        <Skeleton w="40%" h={14} />
                        <Skeleton w="62%" h={12} />
                    </div>
                    <Skeleton w={84} h={22} />
                </div>
            ))}
        </div>
    );
}

// ── Layout helpers ──────────────────────────────────────────────────────────

export function PageHeader({ title, subtitle, actions }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode }) {
    // Inside a hub (Library, Settings, Runs, Release) the hub has the page title: a section gets a quiet heading row.
    if (useEmbedded())
        return (
            <header className="sec-head">
                <div className="titles">
                    <h2 className="t-section">{title}</h2>
                    {subtitle && <div className="sub">{subtitle}</div>}
                </div>
                {actions && <div className="actions">{actions}</div>}
            </header>
        );
    return (
        <header className="page-head">
            <div className="titles">
                <h1 className="t-page">{title}</h1>
                {subtitle && <div className="sub">{subtitle}</div>}
            </div>
            {actions && <div className="actions">{actions}</div>}
        </header>
    );
}

/** A styled file chooser (the browser's native control is inconsistent and unclear). */
export function FilePicker({ id, accept, file, onChange, label = "Choose file" }: { id: string; accept: string; file: File | null; onChange: (f: File | null) => void; label?: string }) {
    const ref = useRef<HTMLInputElement>(null);
    return (
        <div className="file-drop">
            <input ref={ref} id={id} type="file" accept={accept} hidden onChange={(e) => onChange(e.target.files?.[0] ?? null)} />
            <Button size="sm" onClick={() => ref.current?.click()}>
                {file ? "Change file" : label}
            </Button>
            <span className={`truncate ${file ? "" : "muted"}`} style={{ flex: 1 }}>{file ? file.name : "No file selected"}</span>
            {file && (
                <Button size="sm" variant="ghost" onClick={() => { onChange(null); if (ref.current) ref.current.value = ""; }} aria-label="Remove file">
                    Remove
                </Button>
            )}
        </div>
    );
}

/** `tip`: what the number measures, its range and how to read it (from help.ts METRIC_HELP); shown by a "?" beside the label. */
export function Metric({ value, label, tone, tip }: { value: ReactNode; label: string; tone?: "ok" | "warn"; tip?: ReactNode }) {
    return (
        <div className={`metric ${tone ?? ""}`}>
            <div className={typeof value === "string" ? "num txt" : "num"}>{value}</div>
            <div className="lbl">
                {label}
                {tip ? (
                    <>
                        {" "}
                        <HelpTip label={label} text={tip} />
                    </>
                ) : null}
            </div>
        </div>
    );
}

export function Disclosure({ label, children, defaultOpen }: { label: string; children: ReactNode; defaultOpen?: boolean }) {
    return (
        <details className="disclosure" open={defaultOpen}>
            <summary>
                <ChevronRight size={16} className="chev" aria-hidden />
                {label}
            </summary>
            <div className="inner">{children}</div>
        </details>
    );
}

/** A small dropdown for secondary actions. */
export function Menu({ label, icon: Icon, children, iconOnly, variant, wide, dataTour, tip, disabled }: { label: string; icon?: LucideIcon; children: (close: () => void) => ReactNode; iconOnly?: boolean; variant?: Variant; wide?: boolean; /** The guided tour points at this menu by this name. */ dataTour?: string; /** What is in the menu, shown on the button while the menu is closed (an icon-only menu shows its label anyway). */ tip?: ReactNode; /** Switched off: the button does not open, and `tip` says why. */ disabled?: boolean }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    // The menu hangs from its button's right edge; on a narrow screen that can push its left edge off the screen, so slide it back.
    useLayoutEffect(() => {
        const pop = ref.current?.querySelector<HTMLElement>(".menu-pop");
        if (!open || !pop) return;
        pop.style.transform = "";
        const left = pop.getBoundingClientRect().left;
        if (left < 16) pop.style.transform = `translateX(${Math.round(16 - left)}px)`;
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
        const esc = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            setOpen(false);
            // Keyboard users land back on the button that opened the menu.
            ref.current?.querySelector<HTMLElement>(":scope > button")?.focus();
        };
        document.addEventListener("mousedown", away);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("mousedown", away);
            document.removeEventListener("keydown", esc);
        };
    }, [open]);
    return (
        <div className="menu" ref={ref} data-tour={dataTour}>
            <Button variant={variant} icon={Icon} iconOnly={iconOnly} aria-haspopup="menu" aria-expanded={open} aria-label={iconOnly ? label : undefined} tip={tip} disabled={disabled} onClick={() => setOpen((o) => !o)}>
                {iconOnly ? null : label}
            </Button>
            {open && !disabled && (
                <div className={`menu-pop${wide ? " menu-wide" : ""}`} role="menu">
                    {children(() => {
                        setOpen(false);
                        // A dialog opened by an entry gives focus back to this button when it closes.
                        ref.current?.querySelector<HTMLElement>(":scope > button")?.focus();
                    })}
                </div>
            )}
        </div>
    );
}

/** A heading inside a menu that groups the entries after it. */
export function MenuLabel({ children }: { children: ReactNode }) {
    return (
        <div className="menu-label" role="presentation">
            {children}
        </div>
    );
}

/**
 * `description` is one line saying what the entry does; it is read as the entry's description, not as part of its name.
 * `href` entries download a file unless `download={false}` (then they are ordinary links).
 */
export function MenuItem({ icon: Icon, children, onClick, href, hint, disabled, description, download = true, tip }: { icon?: LucideIcon; children: ReactNode; onClick?: () => void; href?: string; hint?: string; disabled?: boolean; description?: string; download?: boolean; /** More about the outcome, shown beside the menu (never over it); the line that must be seen goes in `description`. */ tip?: ReactNode }) {
    const descId = useId();
    const nameId = useId();
    const inner = (
        <>
            {Icon && <Icon size={16} aria-hidden />}
            {description ? (
                <span className="menu-text">
                    <span id={nameId}>{children}</span>
                    <span className="menu-desc" id={descId}>
                        {description}
                    </span>
                </span>
            ) : (
                children
            )}
            {hint && <span className="hint">{hint}</span>}
        </>
    );
    const cls = `menu-item${description ? " has-desc" : ""}`;
    return (
        <Tooltip content={tip} placement="left" strict>
            {href ? (
                <a className={cls} role="menuitem" href={href} download={download ? true : undefined} aria-labelledby={description ? nameId : undefined} aria-describedby={description ? descId : undefined}>
                    {inner}
                </a>
            ) : (
                <button className={cls} role="menuitem" onClick={onClick} disabled={disabled} aria-labelledby={description ? nameId : undefined} aria-describedby={description ? descId : undefined}>
                    {inner}
                </button>
            )}
        </Tooltip>
    );
}

// ── Run ribbon ──────────────────────────────────────────────────────────────

export type Tick = "pass" | "attention" | "fail" | "idle";

/** One tick per test (grouped by verdict, so it reads as a bar). Counts are told in text for anyone who can't see colour. */
const TICK_WORD: Record<Tick, [string, string]> = { pass: ["passing", "passing"], attention: ["needs a look", "need a look"], fail: ["failing", "failing"], idle: ["not run yet", "not run yet"] };

/**
 * Pointing at a part of the ribbon shows how many tests have that verdict and what it means (the counts are also in its label and
 * the legend, so nothing depends on the pointer).
 */
export function Ribbon({ ticks, small, label }: { ticks: Tick[]; small?: boolean; label: string }) {
    const order: Tick[] = ["pass", "attention", "fail", "idle"];
    const sorted = [...ticks].sort((a, b) => order.indexOf(a) - order.indexOf(b));
    const [at, setAt] = useState<Tick | null>(null);
    const n = at ? ticks.filter((t) => t === at).length : 0;
    const content = at ? `${n} ${TICK_WORD[at][n === 1 ? 0 : 1]}. ${RIBBON_TICK[at]}` : label;
    return (
        <Tooltip content={content} delay={200} describe={false}>
            <div
                className={`ribbon ${small ? "sm" : ""}`}
                role="img"
                aria-label={label}
                onPointerMove={(e) => {
                    const t = (e.target as HTMLElement).className as Tick;
                    if (t && t in TICK_WORD && t !== at) setAt(t);
                }}
            >
                {sorted.map((t, i) => (
                    <i key={i} className={t} style={{ animationDelay: `${Math.min(i, 60) * 8}ms` }} />
                ))}
            </div>
        </Tooltip>
    );
}

export function RibbonLegend({ pass, attention, fail, idle }: { pass: number; attention: number; fail: number; idle: number }) {
    const item = (cls: Tick, n: number, text: string) => n > 0 && (
        <span>
            <i className={cls} aria-hidden />
            {n} {text}
        </span>
    );
    return (
        <div className="ribbon-legend">
            {item("pass", pass, "passing")}
            {item("attention", attention, "need a look")}
            {item("fail", fail, "failing")}
            {item("idle", idle, "not run yet")}
        </div>
    );
}
