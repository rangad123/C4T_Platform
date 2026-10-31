/**
 * Tooltips and help tips: one short explanation of a control, status or value, shown in place.
 *
 * - `Tooltip` wraps ONE focusable element (a button, link or a badge made focusable). It opens after a short hover (400 ms) and at
 *   once on keyboard focus; Escape, blur, scrolling and leaving with the pointer close it. It never takes focus or clicks
 *   (pointer-events: none) and is not shown for touch: a tooltip must never carry the only copy of something a person needs.
 * - `HelpTip` is a small "?" button for fields, settings and headings whose meaning is not obvious. Same panel on hover and focus;
 *   a tap or click pins it open until a second tap, a tap elsewhere or Escape (that is how it works on phones).
 * - `FieldHelp` is the label row of a field: label, HelpTip, and optional helper text that stays visible.
 *
 * The panel is rendered in a portal: into the open modal dialog that contains the element (a modal dialog sits in the browser's top
 * layer, anything outside it would be drawn underneath), otherwise into <body>. It is position: fixed, so cards, tables and scroll
 * containers never clip it, and it flips and shifts to stay inside the window. One tooltip is open at a time; moving from one to the
 * next opens the next one at once. Words come from web/src/lib/help.ts (definitions) or the call site (what an action does).
 */
import { CircleHelp } from "lucide-react";
import { Children, cloneElement, isValidElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode, type Ref } from "react";
import { createPortal } from "react-dom";
import { placePanel, type Placement } from "./tooltip-place";
import "./tooltip.css";

export type { Placement } from "./tooltip-place";

/** Hover delays (ms). Moving from one tooltip to another within WARM_MS opens the next without waiting. */
export const OPEN_DELAY = 400;
export const CLOSE_DELAY = 100;
const WARM_MS = 500;

// ── one open tooltip at a time ──────────────────────────────────────────────
let closeCurrent: (() => void) | null = null;
let warmUntil = 0;
function claim(close: () => void) {
    if (closeCurrent && closeCurrent !== close) closeCurrent();
    closeCurrent = close;
}
function release(close: () => void) {
    if (closeCurrent === close) {
        closeCurrent = null;
        warmUntil = Date.now() + WARM_MS;
    }
}

function setRef<T>(ref: Ref<T> | undefined, value: T | null) {
    if (typeof ref === "function") ref(value);
    else if (ref && typeof ref === "object") (ref as { current: T | null }).current = value;
}

/** Where the panel goes: the open modal dialog around the element (top layer), else <body>. */
function portalHost(el: Element | null): HTMLElement | null {
    if (typeof document === "undefined") return null;
    const dialog = el?.closest("dialog");
    return (dialog as HTMLElement | null) ?? document.body;
}

interface TipOptions {
    placement: Placement;
    delay: number;
    /** HelpTip: a tap or click pins the panel open. */
    toggle?: boolean;
    disabled?: boolean;
    /** Only the placement's axis; when neither side fits it stays hidden. */
    strict?: boolean;
    /** A wider panel, for a key that lists several definitions (BadgeKey). */
    wide?: boolean;
}

/** The shared behaviour of Tooltip and HelpTip: state, timers, listeners, portal panel. */
function useTip(content: ReactNode, opts: TipOptions) {
    const id = useId();
    const anchorRef = useRef<HTMLElement | null>(null);
    const panelRef = useRef<HTMLDivElement | null>(null);
    const [open, setOpen] = useState(false);
    const [pinned, setPinned] = useState(false);
    const [host, setHost] = useState<HTMLElement | null>(null);
    const timer = useRef<number | undefined>(undefined);
    // After a press, a hover does not reopen it until the pointer has left.
    const suppressed = useRef(false);
    const empty = content === null || content === undefined || content === false || (typeof content === "string" && content.trim() === "");
    const disabled = opts.disabled || empty;

    const clear = () => window.clearTimeout(timer.current);
    const close = useCallback(() => {
        window.clearTimeout(timer.current);
        setOpen(false);
        setPinned(false);
    }, []);
    const show = useCallback(() => {
        if (disabled) return;
        // Never cover a menu or list the element itself opened.
        if (anchorRef.current?.getAttribute("aria-expanded") === "true" && !opts.toggle) return;
        claim(close);
        setOpen(true);
    }, [disabled, close, opts.toggle]);
    const showLater = (ms: number) => {
        clear();
        if (Date.now() < warmUntil || closeCurrent) return show();
        timer.current = window.setTimeout(show, ms);
    };
    const hideLater = () => {
        clear();
        if (pinned) return;
        timer.current = window.setTimeout(close, CLOSE_DELAY);
    };

    useEffect(() => {
        if (!open) release(close);
    }, [open, close]);
    // A tip that goes away while shown (a button became busy) closes.
    useEffect(() => {
        if (disabled && open) close();
    }, [disabled, open, close]);
    useEffect(() => () => {
        window.clearTimeout(timer.current);
        release(close);
    }, [close]);
    useLayoutEffect(() => {
        setHost(portalHost(anchorRef.current));
    }, []);

    // While open: Escape closes it (and only it), scrolling and resizing close it, a tap elsewhere closes a pinned one.
    useEffect(() => {
        if (!open) return;
        const esc = (e: KeyboardEvent) => {
            if (e.key !== "Escape") return;
            // Escape belongs to the tooltip while it is open: the dialog or menu around it stays open.
            e.preventDefault();
            e.stopImmediatePropagation();
            close();
        };
        const scroll = (e: Event) => {
            if (panelRef.current && e.target instanceof Node && panelRef.current.contains(e.target)) return;
            // Tabbing to an element scrolls it into view: a tip opened by the keyboard follows its element instead of closing,
            // until the element leaves the window. A hover tip closes.
            const a = anchorRef.current;
            if (a && a === document.activeElement) {
                const r = a.getBoundingClientRect();
                if (r.bottom > 0 && r.top < window.innerHeight && r.right > 0 && r.left < document.documentElement.clientWidth) return placeNow();
            }
            close();
        };
        const away = (e: PointerEvent) => {
            if (anchorRef.current?.contains(e.target as Node)) return;
            close();
        };
        window.addEventListener("keydown", esc, true);
        window.addEventListener("scroll", scroll, true);
        window.addEventListener("resize", close);
        document.addEventListener("pointerdown", away, true);
        return () => {
            window.removeEventListener("keydown", esc, true);
            window.removeEventListener("scroll", scroll, true);
            window.removeEventListener("resize", close);
            document.removeEventListener("pointerdown", away, true);
        };
    }, [open, close]);

    // Position after render, then correct for any containing block that is not the window.
    useLayoutEffect(() => {
        if (open) placeNow();
    }, [open, opts.placement, opts.strict, content]);

    function placeNow() {
        const a = anchorRef.current;
        const p = panelRef.current;
        if (!a || !p) return;
        p.style.top = "0px";
        p.style.left = "0px";
        const origin = p.getBoundingClientRect();
        const pos = placePanel(a.getBoundingClientRect(), { width: origin.width, height: origin.height }, opts.placement, { width: document.documentElement.clientWidth, height: window.innerHeight }, opts.strict);
        p.style.top = `${pos.top - origin.top}px`;
        p.style.left = `${pos.left - origin.left}px`;
        p.style.visibility = opts.strict && !pos.fits ? "hidden" : "";
        p.dataset.placement = pos.placement;
    }

    const handlers = {
        onPointerEnter: (e: React.PointerEvent) => {
            if (e.pointerType === "touch" || suppressed.current) return;
            showLater(opts.delay);
        },
        onPointerLeave: (e: React.PointerEvent) => {
            suppressed.current = false;
            if (e.pointerType === "touch") return;
            hideLater();
        },
        onFocus: (e: React.FocusEvent) => {
            // Keyboard focus shows it at once; focus that comes from a click or tap does not.
            let keyboard = true;
            try {
                keyboard = (e.currentTarget as HTMLElement).matches(":focus-visible");
            } catch {
                /* very old browsers: treat as keyboard */
            }
            if (keyboard) {
                clear();
                show();
            }
        },
        onBlur: () => {
            clear();
            close();
        },
        onPointerDown: () => {
            if (opts.toggle) return;
            suppressed.current = true;
            clear();
            close();
        },
        onKeyDown: (e: React.KeyboardEvent) => {
            // Pressing the element (Enter or Space) does its job; the tooltip gets out of the way.
            if (!opts.toggle && (e.key === "Enter" || e.key === " ")) close();
        },
        onClick: () => {
            if (!opts.toggle) return;
            clear();
            if (pinned) close();
            else {
                show();
                setPinned(true);
            }
        },
    };

    const panel =
        host && !disabled
            ? createPortal(
                  // aria-hidden: screen readers hear the text as the element's description (aria-describedby reads hidden text too),
                  // not a second time as stray text at the end of the page, outside any landmark.
                  <div ref={panelRef} id={id} role="tooltip" aria-hidden="true" className={`tt${opts.wide ? " tt-wide" : ""}${open ? " is-open" : ""}`} hidden={!open}>
                      {content}
                  </div>,
                  host,
              )
            : null;
    return { id, anchorRef, open, pinned, handlers, panel, disabled };
}

type AnyProps = Record<string, unknown>;
const chain = (theirs: unknown, ours: (e: never) => void) => (e: never) => {
    if (typeof theirs === "function") theirs(e);
    ours(e);
};

export interface TooltipProps {
    /** One or two short sentences: what happens, why, or what a value means. Empty content renders the child alone. */
    content: ReactNode;
    placement?: Placement;
    /** Hover delay in ms (default 400). Keyboard focus always opens at once. */
    delay?: number;
    /** A single element that can take keyboard focus (button, link, or an element with tabIndex={0}). */
    children: ReactElement;
    disabled?: boolean;
    /** Stay on the placement's axis (left/right or top/bottom); hidden when neither side fits. For tips beside menu entries. */
    strict?: boolean;
    /** false: do not add aria-describedby (the tip only repeats what the element's accessible name already says). */
    describe?: boolean;
}

/** Wraps one focusable element; adds `aria-describedby` and shows `content` on hover (after a delay) and keyboard focus. */
export function Tooltip({ content, placement = "top", delay = OPEN_DELAY, children, disabled, strict, describe = true }: TooltipProps) {
    const tip = useTip(content, { placement, delay, disabled, strict });
    const child = Children.only(children);
    if (!isValidElement(child)) return child;
    // The element is always cloned the same way, with or without a tip, so it is never re-created (and never loses focus) when its
    // tip comes or goes, for example while a button is busy.
    const p = child.props as AnyProps;
    const describedBy = [p["aria-describedby"], tip.disabled || !describe ? undefined : tip.id].filter(Boolean).join(" ") || undefined;
    const childRef = (child as unknown as { ref?: Ref<HTMLElement> }).ref;
    const h = tip.handlers;
    return (
        <>
            {cloneElement(child as ReactElement<AnyProps>, {
                ref: (node: HTMLElement | null) => {
                    tip.anchorRef.current = node;
                    setRef(childRef, node);
                },
                "aria-describedby": describedBy,
                onPointerEnter: chain(p.onPointerEnter, h.onPointerEnter as (e: never) => void),
                onPointerLeave: chain(p.onPointerLeave, h.onPointerLeave as (e: never) => void),
                onPointerDown: chain(p.onPointerDown, h.onPointerDown as (e: never) => void),
                onFocus: chain(p.onFocus, h.onFocus as (e: never) => void),
                onBlur: chain(p.onBlur, h.onBlur as (e: never) => void),
                onKeyDown: chain(p.onKeyDown, h.onKeyDown as (e: never) => void),
            })}
            {tip.panel}
        </>
    );
}

export interface HelpTipProps {
    /** What it explains, e.g. "Requests per second": the button is named "About Requests per second". */
    label: string;
    /** The explanation: one or two short sentences. */
    text: ReactNode;
    placement?: Placement;
    className?: string;
    /** A wider panel (BadgeKey's list of definitions). */
    wide?: boolean;
}

/** A small "?" button that explains `label`: hover or focus shows it, a tap or click pins it until a second tap, a tap elsewhere or Escape. */
export function HelpTip({ label, text, placement = "top", className, wide }: HelpTipProps) {
    const tip = useTip(text, { placement, delay: OPEN_DELAY, toggle: true, wide });
    const h = tip.handlers;
    return (
        <>
            <button
                type="button"
                ref={(n) => {
                    tip.anchorRef.current = n;
                }}
                className={`help-tip${className ? ` ${className}` : ""}`}
                aria-label={`About ${label}`}
                aria-describedby={tip.id}
                aria-expanded={tip.pinned}
                onPointerEnter={h.onPointerEnter}
                onPointerLeave={h.onPointerLeave}
                onFocus={h.onFocus}
                onBlur={h.onBlur}
                onClick={h.onClick}
            >
                <CircleHelp size={16} aria-hidden />
            </button>
            {tip.panel}
        </>
    );
}

/** One line of a BadgeKey: the word on the badge and what it means. */
export interface KeyEntry {
    word: string;
    text: string | undefined;
}

/**
 * The entries of a BadgeKey for the values a list shows now: one per value present (`present`), in the order of `order` (the order the
 * definitions are read in), each with its word and definition. Values without a definition are left out.
 */
export function keyEntries<K extends string>(order: readonly K[], present: Iterable<K | null | undefined | false>, word: (k: K) => string, text: (k: K) => string | undefined): KeyEntry[] {
    const shown = new Set<string>();
    for (const v of present) if (v) shown.add(v);
    return order.filter((k) => shown.has(k)).map((k) => ({ word: word(k), text: text(k) }));
}

/**
 * The keyboard's way to the badges of a list or table. Badges in rows are not tab stops (a list would get one stop per row), so a list
 * gets one "?" (in its status column heading, or beside the list) that lists the values it shows, each with its definition from
 * help.ts. Renders nothing when there is nothing to explain.
 */
export function BadgeKey({ label, entries, placement }: { /** What it explains: the button is named "About <label>". */ label: string; entries: Array<KeyEntry | null | undefined | false>; placement?: Placement }) {
    const seen = new Set<string>();
    const rows = entries.filter((e): e is KeyEntry => {
        if (!e || !e.text || seen.has(e.word)) return false;
        seen.add(e.word);
        return true;
    });
    if (rows.length === 0) return null;
    return (
        <HelpTip
            label={label}
            placement={placement}
            wide
            text={
                <span className="tt-key">
                    {rows.map((r) => (
                        <span key={r.word} className="tt-key-row">
                            {/* The colon inside the word's own element: a page's exact text "Delivered" is the badge, not this line. */}
                            <span className="tt-key-word">{r.word}:</span> {r.text}{" "}
                        </span>
                    ))}
                </span>
            }
        />
    );
}

export interface FieldHelpProps {
    /** The id of the input the label is for. */
    htmlFor: string;
    label: ReactNode;
    /** The HelpTip's explanation (optional): what the setting does or means. */
    help?: ReactNode;
    /** Text that stays visible under the label (instructions, limits, warnings: never hover-only). Give the input aria-describedby={`${htmlFor}-hint`}. */
    hint?: ReactNode;
    /**
     * A short name for the HelpTip ("About <helpLabel>"). Default: the label without a trailing "(optional)"-style note, or "this field"
     * when the label is not plain text. Tests should find fields with getByLabel(label, { exact: true }): the help button's name
     * contains the field's words.
     */
    helpLabel?: string;
}

/** The label row of a field: label + HelpTip, and the persistent helper text with id `${htmlFor}-hint`. */
export function FieldHelp({ htmlFor, label, help, hint, helpLabel }: FieldHelpProps) {
    return (
        <>
            <div className="field-label-row">
                <label htmlFor={htmlFor}>{label}</label>
                {help ? <HelpTip label={helpLabel ?? (typeof label === "string" ? label.replace(/\s*\([^)]*\)\s*$/, "").trim() || label : "this field")} text={help} /> : null}
            </div>
            {hint ? (
                <p className="hint" id={`${htmlFor}-hint`}>
                    {hint}
                </p>
            ) : null}
        </>
    );
}
