import { useEffect, useRef, useState } from "react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { FieldHelp } from "../../components/Tooltip";
import { describeApiError } from "../../lib/labels";
import { appliesToText, COMMON_ROLES, KIND_TEXT, STRATEGIES, type ChangeResult, type ElementKind, type ElementLocator, type SharedElement, type Strategy } from "./objects";
import "./objects.css";

interface Props {
    projectId: string;
    /** Absent = a new element. */
    element?: SharedElement;
    onClose: () => void;
    onDone: (result: ChangeResult | SharedElement, kind: "added" | "changed") => void;
    /** Shown to read only (the person may not change shared elements here): every field is switched off and nothing is saved. */
    readOnly?: boolean;
}

/** A modal form to add an element or change one. Changing the locator of a used element tells how many tests follow. */
export function ElementDialog({ projectId, element, onClose, onDone, readOnly = false }: Props) {
    const ref = useRef<HTMLDialogElement>(null);
    const nameRef = useRef<HTMLInputElement>(null);
    const l = element?.locator;
    const [name, setName] = useState(element?.name ?? "");
    const [kind, setKind] = useState<ElementKind>(element?.kind ?? "web");
    const [page, setPage] = useState(element?.page ?? "");
    const [by, setBy] = useState<Strategy>(l?.by ?? "role");
    const [role, setRole] = useState(l?.role ?? "button");
    const [value, setValue] = useState(l?.value ?? "");
    const [exact, setExact] = useState(Boolean(l?.exact));
    const [nth, setNth] = useState(l?.nth !== undefined ? String(l.nth + 1) : "");
    const [notes, setNotes] = useState(element?.notes ?? "");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
        nameRef.current?.focus();
    }, []);

    const strategies = STRATEGIES.filter((s) => s.kinds.includes(kind));
    const strategy = STRATEGIES.find((s) => s.id === by)!;
    const usesExact = by === "role" || by === "label" || by === "text" || by === "placeholder";

    function changeKind(k: ElementKind) {
        setKind(k);
        if (!STRATEGIES.find((s) => s.id === by)!.kinds.includes(k)) setBy("role");
    }

    async function submit(e: React.FormEvent) {
        e.preventDefault();
        if (readOnly) return;
        setError("");
        if (!name.trim()) return setError("Give the element a name.");
        if (by !== "role" && !value.trim()) return setError(`Enter the ${strategy.valueLabel.toLowerCase()}.`);
        if (by === "role" && !role.trim()) return setError("Enter the role, for example button.");
        const n = nth.trim() === "" ? undefined : Number(nth);
        if (n !== undefined && (!Number.isInteger(n) || n < 1 || n > 101)) return setError("The position is a whole number from 1 (the first match).");
        const locator: ElementLocator = {
            by,
            ...(by === "role" ? { role: role.trim() } : {}),
            ...(value.trim() ? { value: value.trim() } : {}),
            ...(usesExact && exact ? { exact: true } : {}),
            ...(n !== undefined ? { nth: n - 1 } : {}),
        };
        setBusy(true);
        try {
            if (element) {
                const out = await api<ChangeResult>(`/projects/${projectId}/objects/${element.id}`, { method: "PUT", body: { name: name.trim(), locator, page: page.trim() || null, notes: notes.trim() || null, expectedVersion: element.version } });
                onDone(out, "changed");
            } else {
                const out = await api<SharedElement>(`/projects/${projectId}/objects`, { method: "POST", body: { name: name.trim(), kind, locator, ...(page.trim() ? { page: page.trim() } : {}), ...(notes.trim() ? { notes: notes.trim() } : {}) } });
                onDone(out, "added");
            }
        } catch (err) {
            setError(describeApiError(err));
            setBusy(false);
        }
    }

    const users = element?.usedBy.count ?? 0;
    return (
        <dialog ref={ref} className="obj-dialog" aria-labelledby="obj-dialog-title" onClose={onClose} onCancel={onClose}>
            <form className="inner" onSubmit={submit} noValidate>
                <h2 className="t-section" id="obj-dialog-title">
                    {readOnly ? "Element" : element ? "Edit element" : "Add element"}
                </h2>
                <div className="field">
                    <label htmlFor="obj-name">Name</label>
                    <input disabled={readOnly} id="obj-name" ref={nameRef} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Cart / Checkout button" aria-describedby="obj-name-help" />
                    <span className="t-meta" id="obj-name-help">Tests refer to the element by this name. A slash groups related elements.</span>
                </div>
                <div className="obj-two">
                    <div className="field">
                        <label htmlFor="obj-kind">Kind</label>
                        <select id="obj-kind" className="input" value={kind} disabled={readOnly || Boolean(element)} onChange={(e) => changeKind(e.target.value as ElementKind)}>
                            {(Object.keys(KIND_TEXT) as ElementKind[]).map((k) => (
                                <option key={k} value={k}>{KIND_TEXT[k]}</option>
                            ))}
                        </select>
                    </div>
                    <div className="field">
                        <FieldHelp htmlFor="obj-page" label="Page (optional)" help="Only groups the element under this page in the list. It does not change how the element is found." />
                        <input disabled={readOnly} id="obj-page" className="input" value={page} maxLength={80} onChange={(e) => setPage(e.target.value)} placeholder="Cart" />
                    </div>
                </div>
                <fieldset className="obj-locator">
                    <legend>How to find it</legend>
                    <div className="obj-two">
                        <div className="field">
                            <label htmlFor="obj-by">Find it by</label>
                            <select disabled={readOnly} id="obj-by" className="input" value={by} onChange={(e) => setBy(e.target.value as Strategy)}>
                                {strategies.map((s) => (
                                    <option key={s.id} value={s.id}>{s.label}</option>
                                ))}
                            </select>
                        </div>
                        {by === "role" && (
                            <div className="field">
                                <label htmlFor="obj-role">Role</label>
                                <input disabled={readOnly} id="obj-role" className="input" list="obj-roles" value={role} onChange={(e) => setRole(e.target.value)} />
                                <datalist id="obj-roles">{COMMON_ROLES.map((r) => <option key={r} value={r} />)}</datalist>
                            </div>
                        )}
                    </div>
                    <div className="field">
                        <label htmlFor="obj-value">{strategy.valueLabel}</label>
                        <input disabled={readOnly} id="obj-value" className="input" value={value} maxLength={500} onChange={(e) => setValue(e.target.value)} />
                    </div>
                    <div className="obj-two">
                        {usesExact && (
                            <label className="obj-check">
                                <input disabled={readOnly} type="checkbox" checked={exact} onChange={(e) => setExact(e.target.checked)} /> Match the whole text exactly
                            </label>
                        )}
                        <div className="field">
                            <label htmlFor="obj-nth">Position if several match (optional)</label>
                            <input disabled={readOnly} id="obj-nth" className="input obj-nth" inputMode="numeric" value={nth} onChange={(e) => setNth(e.target.value)} placeholder="1" />
                        </div>
                    </div>
                </fieldset>
                <div className="field">
                    <label htmlFor="obj-notes">Notes (optional)</label>
                    <textarea disabled={readOnly} id="obj-notes" className="input" rows={2} maxLength={300} value={notes} onChange={(e) => setNotes(e.target.value)} />
                </div>
                {element && users > 0 && (
                    <Callout tone="info">
                        {appliesToText(users)} If you change how the element is found, those tests are updated and run again.
                    </Callout>
                )}
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button type="button" variant="ghost" onClick={() => ref.current?.close()} disabled={busy}>{readOnly ? "Close" : "Cancel"}</Button>
                    {!readOnly && <Button type="submit" variant="primary" loading={busy}>{element ? "Save changes" : "Add element"}</Button>}
                </div>
            </form>
        </dialog>
    );
}
