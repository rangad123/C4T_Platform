import { Link2 } from "lucide-react";
import { Button } from "../../components/ui";
import { FieldHelp } from "../../components/Tooltip";
import { STRATEGY_LABEL, VALUE_LABEL, type Catalog } from "./builder";

export interface SharedElement {
    name: string;
    page?: string | null;
}
type Frame = { by: string; value: string };
type Loc = { by?: string; role?: string; value?: string; exact?: boolean; nth?: number; ref?: string; frame?: Frame[] } | undefined;

const FRAME_BY_LABEL: Record<string, string> = { name: "A frame with this name", title: "A frame with this title", url: "A frame whose address contains" };

/** Which frame (iframe) the element is in. One frame is edited here; a deeper chain the recorder saved is shown and can be removed. */
function FrameField({ id, frame, onChange }: { id: string; frame?: Frame[]; onChange: (f: Frame[] | undefined) => void }) {
    if (frame && frame.length > 1) {
        return (
            <div className="field">
                <p className="hint" id={`${id}-frame`}>
                    Inside {frame.length} frames: {frame.map((f) => `“${f.value}”`).join(", then ")}.
                </p>
                <Button size="sm" variant="ghost" onClick={() => onChange(undefined)}>
                    Not in a frame
                </Button>
            </div>
        );
    }
    const f = frame?.[0];
    return (
        <div className="bld-locator-more">
            <div className="field">
                <FieldHelp htmlFor={`${id}-frame-by`} label="Inside a frame" help="Only when the element is inside a page embedded in the page (an iframe), such as a card payment form." />
                <select id={`${id}-frame-by`} className="input" value={f?.by ?? ""} onChange={(e) => onChange(e.target.value ? [{ by: e.target.value, value: f?.value ?? "" }] : undefined)}>
                    <option value="">Not in a frame</option>
                    {Object.entries(FRAME_BY_LABEL).map(([k, label]) => (
                        <option key={k} value={k}>
                            {label}
                        </option>
                    ))}
                </select>
            </div>
            {f && (
                <div className="field">
                    <label htmlFor={`${id}-frame-value`}>{f.by === "url" ? "Part of the frame’s address" : f.by === "title" ? "Frame title" : "Frame name"}</label>
                    <input id={`${id}-frame-value`} className="input" value={f.value} autoComplete="off" onChange={(e) => onChange([{ by: f.by, value: e.target.value }])} />
                </div>
            )}
        </div>
    );
}

interface Props {
    /** Unique on the page: the ids of the inputs start with it. */
    id: string;
    label: string;
    value: Loc;
    onChange: (l: Loc) => void;
    optional?: boolean;
    shared: SharedElement[] | null;
    catalog: Pick<Catalog, "roles" | "locatorStrategies">;
}

const NONE = "none";
const SHARED = "ref";

/** Choose how to find an element: by role, label, text, placeholder, test id or selector, or pick a shared element from the object repository. */
export function LocatorField({ id, label, value, onChange, optional, shared, catalog }: Props) {
    const mode = !value ? NONE : typeof value.ref === "string" ? SHARED : (value.by ?? "role");
    const set = (patch: Record<string, unknown>) => onChange({ ...(value as object), ...patch } as Loc);

    function changeMode(next: string) {
        if (next === NONE) return onChange(undefined);
        if (next === SHARED) return onChange({ ref: shared?.[0]?.name ?? "" });
        // Keep the text when only the way of finding changes.
        const text = value && typeof value.ref !== "string" ? (value.value ?? "") : "";
        onChange(next === "role" ? { by: "role", role: value?.role ?? "button", value: text } : { by: next, value: text });
    }

    const refName = typeof value?.ref === "string" ? value.ref : "";
    const known = !!shared?.some((s) => s.name === refName);

    return (
        <fieldset className="bld-locator">
            <legend>{label}</legend>
            <div className="field">
                <FieldHelp
                    htmlFor={`${id}-by`}
                    label="How to find it"
                    help="Role and name, a field's label, its text or its placeholder find an element by what a person sees. A test id or a CSS selector depend on the page's code. A shared element is named once and fixed in one place for every test."
                />
                <select id={`${id}-by`} className="input" value={mode} onChange={(e) => changeMode(e.target.value)}>
                    {optional && <option value={NONE}>No element, use the whole page</option>}
                    {catalog.locatorStrategies.map((s) => (
                        <option key={s} value={s}>
                            {STRATEGY_LABEL[s] ?? s}
                        </option>
                    ))}
                    <option value={SHARED}>Use a shared element</option>
                </select>
            </div>

            {mode === SHARED && (
                <div className="field">
                    <label htmlFor={`${id}-ref`}>
                        <Link2 size={14} aria-hidden /> Shared element
                    </label>
                    {shared === null ? (
                        <p className="hint">Shared elements are not available right now.</p>
                    ) : shared.length === 0 && !refName ? (
                        <p className="hint">This project has no shared elements yet. Make one from a step in the recorder, then use it here.</p>
                    ) : (
                        <select id={`${id}-ref`} className="input" value={refName} onChange={(e) => onChange({ ref: e.target.value })}>
                            {!known && refName && <option value={refName}>{refName} (not in the project)</option>}
                            {shared.map((s) => (
                                <option key={s.name} value={s.name}>
                                    {s.name}
                                    {s.page ? `, ${s.page}` : ""}
                                </option>
                            ))}
                        </select>
                    )}
                    <p className="hint">A fix to a shared element applies to every test that uses it.</p>
                </div>
            )}

            {mode !== NONE && mode !== SHARED && (
                <>
                    {mode === "role" && (
                        <div className="field">
                            <FieldHelp htmlFor={`${id}-role`} label="Role" help="The kind of element, as a screen reader names it: button, link, textbox, checkbox, heading and so on." />
                            <input id={`${id}-role`} className="input" list={`${id}-roles`} value={value?.role ?? ""} placeholder="button" autoComplete="off" onChange={(e) => set({ role: e.target.value })} />
                            <datalist id={`${id}-roles`}>
                                {catalog.roles.map((r) => (
                                    <option key={r} value={r} />
                                ))}
                            </datalist>
                        </div>
                    )}
                    <div className="field">
                        <label htmlFor={`${id}-value`}>{VALUE_LABEL[mode] ?? "Value"}</label>
                        <input id={`${id}-value`} className="input" value={value?.value ?? ""} autoComplete="off" onChange={(e) => set({ value: e.target.value })} />
                    </div>
                    <div className="bld-locator-more">
                        {mode !== "css" && mode !== "testId" && (
                            <label className="bld-check">
                                <input type="checkbox" checked={value?.exact === true} onChange={(e) => set({ exact: e.target.checked ? true : undefined })} />
                                <span>Match the whole text exactly</span>
                            </label>
                        )}
                        <div className="field">
                            <label htmlFor={`${id}-nth`}>If several match, use number (optional)</label>
                            <input
                                id={`${id}-nth`}
                                className="input bld-narrow"
                                type="number"
                                min={1}
                                value={value?.nth === undefined ? "" : value.nth + 1}
                                onChange={(e) => set({ nth: e.target.value === "" ? undefined : Math.max(0, Math.floor(Number(e.target.value)) - 1) })}
                            />
                        </div>
                    </div>
                    <FrameField id={id} frame={value?.frame} onChange={(fr) => set({ frame: fr })} />
                </>
            )}
        </fieldset>
    );
}
