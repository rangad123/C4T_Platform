import { Check, X, type LucideIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { api } from "../../api";
import { Modal } from "../../components/Modal";
import { Button, Callout } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { describeApiError } from "../../lib/labels";
import "./script-manage.css";

/** The same limits the server keeps (src/platform/routes/test-manage.ts). */
export const TITLE_MIN = 3;
export const TITLE_MAX = 200;

/** What is wrong with a new name, in a sentence, or null when it can be saved. */
export function titleProblem(title: string): string | null {
    const t = title.trim();
    if (t.length < TITLE_MIN) return `A script needs a name of at least ${TITLE_MIN} characters.`;
    if (t.length > TITLE_MAX) return `A script name is at most ${TITLE_MAX} characters.`;
    return null;
}

/**
 * The name of a script as a field, in place of the name: Enter or Save keeps it, Escape or Cancel leaves it as it was. What the
 * server refuses is said under the field, as it said it.
 */
export function RenameScript({ testId, title, onDone, onCancel }: { testId: string; title: string; onDone: (title: string) => void; onCancel: () => void }) {
    const [value, setValue] = useState(title);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const errId = `rename-err-${testId}`;

    async function save() {
        const problem = titleProblem(value);
        if (problem) return setError(problem);
        if (value.trim() === title) return onCancel();
        setBusy(true);
        try {
            const r = await api<{ title: string }>(`/tests/${testId}`, { method: "PATCH", body: { title: value.trim() } });
            onDone(r.title);
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }
    const keys = (e: KeyboardEvent) => {
        if (e.key === "Escape") (e.preventDefault(), e.stopPropagation(), onCancel());
    };

    return (
        <form
            className="rename-script"
            onSubmit={(e) => {
                e.preventDefault();
                void save();
            }}
            onKeyDown={keys}
            onClick={(e) => e.stopPropagation()}
            noValidate
        >
            <div className="rename-row">
                <input
                    className="input"
                    value={value}
                    maxLength={TITLE_MAX + 20}
                    autoFocus
                    aria-label="New name of the script"
                    aria-invalid={error ? true : undefined}
                    aria-describedby={error ? errId : undefined}
                    onChange={(e) => (setValue(e.target.value), setError(null))}
                />
                <Button type="submit" size="sm" variant="primary" icon={Check} loading={busy}>
                    Save
                </Button>
                <Button type="button" size="sm" variant="ghost" icon={X} disabled={busy} onClick={onCancel}>
                    Cancel
                </Button>
            </div>
            {error && (
                <span className="error-text" id={errId} role="alert">
                    {error}
                </span>
            )}
        </form>
    );
}

/** Asks before a script is deleted, and says in plain words what goes with it. */
export function DeleteScriptDialog({ testId, title, onClose, onDeleted }: { testId: string; title: string; onClose: () => void; onDeleted: () => void }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    async function remove() {
        setBusy(true);
        setError(null);
        try {
            await api(`/tests/${testId}`, { method: "DELETE" });
            onDeleted();
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <Modal
            title={`Delete “${title}”?`}
            titleId={`delete-script-${testId}`}
            testId="delete-script-dialog"
            onClose={onClose}
            foot={
                <>
                    <Button data-autofocus onClick={onClose}>
                        Keep it
                    </Button>
                    <Button variant="danger" loading={busy} onClick={() => void remove()}>
                        Delete script
                    </Button>
                </>
            }
        >
            <p className="t-secondary">
                The script goes with everything made of it: its steps and code, every earlier version and review, and its run history with the results,
                screenshots and videos. It leaves the suites it is in, and requirements no longer list it. Deleting cannot be undone.
            </p>
            {error && (
                <Callout tone="danger" title="It wasn’t deleted">
                    {error}
                </Callout>
            )}
        </Modal>
    );
}

/**
 * A small icon button in a script's row. Its accessible name says which script (`name`); its tooltip stays short (`tip`) and never
 * repeats the script's name, so the row's text is found once.
 */
export function RowIconButton({ icon: Icon, name, tip, disabled, onClick, ...rest }: { icon: LucideIcon; name: string; tip: string; disabled?: boolean; onClick: () => void; [data: `data-${string}`]: string | undefined }) {
    const btn = (
        <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={name} disabled={disabled} onClick={onClick} {...rest}>
            <Icon size={16} aria-hidden />
        </button>
    );
    return disabled ? btn : (
        <Tooltip content={tip} describe={false}>
            {btn}
        </Tooltip>
    );
}

/**
 * The row's menu: the same look and keys as the app's Menu, named for its script without repeating the name in its tooltip. It is
 * placed against the screen, not the row: the list's card hides what overflows it (so the last row's menu was cut off), and on a
 * narrow screen the button sits at the row's left, where a menu hanging from its right edge ran off the screen.
 */
export function RowMenu({ icon, name, tip, children }: { icon: LucideIcon; name: string; tip: string; children: (close: () => void) => ReactNode }) {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);
    const button = () => ref.current?.querySelector<HTMLElement>(":scope > button");
    useLayoutEffect(() => {
        const pop = ref.current?.querySelector<HTMLElement>(".menu-pop");
        if (!open || !pop) return;
        const place = () => {
            const b = button()?.getBoundingClientRect();
            if (!b) return;
            const w = pop.offsetWidth;
            const h = pop.offsetHeight;
            const width = document.documentElement.clientWidth;
            // Under the button, its right edge on the button's, kept 16 px inside the screen; above the button when there is no room below.
            const left = Math.max(16, Math.min(b.right - w, width - 16 - w));
            const top = b.bottom + 6 + h <= window.innerHeight - 8 ? b.bottom + 6 : Math.max(8, b.top - 6 - h);
            Object.assign(pop.style, { position: "fixed", left: `${left}px`, top: `${top}px`, right: "auto" });
        };
        place();
        window.addEventListener("scroll", place, true);
        window.addEventListener("resize", place);
        return () => {
            window.removeEventListener("scroll", place, true);
            window.removeEventListener("resize", place);
        };
    }, [open]);
    useEffect(() => {
        if (!open) return;
        const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
        const esc = (e: globalThis.KeyboardEvent) => {
            if (e.key !== "Escape") return;
            setOpen(false);
            button()?.focus();
        };
        document.addEventListener("mousedown", away);
        document.addEventListener("keydown", esc);
        return () => {
            document.removeEventListener("mousedown", away);
            document.removeEventListener("keydown", esc);
        };
    }, [open]);
    const Icon = icon;
    return (
        <div className="menu" ref={ref}>
            <Tooltip content={tip} describe={false}>
                <button type="button" className="btn btn-ghost btn-sm btn-icon" aria-label={name} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
                    <Icon size={16} aria-hidden />
                </button>
            </Tooltip>
            {open && (
                <div className="menu-pop" role="menu">
                    {children(() => {
                        setOpen(false);
                        button()?.focus();
                    })}
                </div>
            )}
        </div>
    );
}
