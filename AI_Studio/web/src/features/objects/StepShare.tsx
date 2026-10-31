import { Link2 } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout, Term } from "../../components/ui";
import { Tooltip } from "../../components/Tooltip";
import { describeApiError } from "../../lib/labels";
import { routes } from "../../lib/router";
import "./objects.css";

interface Props {
    projectId: string;
    testId: string;
    kind: string;
    stepIndex: number;
    step: { locator?: { ref?: string; by?: string } };
    onChanged: () => void;
}

/**
 * On a test's step: a chip naming the shared element the step uses (a link to the Objects tab), or, for a step that spells its
 * locator out, a "Use as shared element" action that turns it into a named element.
 */
export function StepShare({ projectId, testId, kind, stepIndex, step, onChanged }: Props) {
    const [open, setOpen] = useState(false);
    const [name, setName] = useState("");
    const [everywhere, setEverywhere] = useState(true);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const loc = step.locator;
    if (!loc) return null;
    if (loc.ref !== undefined && loc.by === undefined) {
        return (
            <Tooltip content="This step finds its element through a shared element. Opens the project's shared elements, where a fix applies to every test that uses it.">
                <a className="obj-chip" href={routes.objects(projectId)} data-testid="shared-chip">
                    <Link2 size={12} aria-hidden /> Shared: {loc.ref}
                </a>
            </Tooltip>
        );
    }
    if (!["web", "mobile", "desktop"].includes(kind)) return null;

    async function share(e: React.FormEvent) {
        e.preventDefault();
        setBusy(true);
        setError("");
        try {
            await api(`/tests/${testId}/steps/${stepIndex}/share`, { method: "POST", body: { ...(name.trim() ? { name: name.trim() } : {}), everywhere } });
            setOpen(false);
            onChanged();
        } catch (err) {
            setError(describeApiError(err));
        } finally {
            setBusy(false);
        }
    }

    if (!open) {
        return (
            <Button size="sm" variant="ghost" className="obj-share" onClick={() => setOpen(true)} aria-label={`Use step ${stepIndex + 1} as a shared element`}>
                Use as shared element
            </Button>
        );
    }
    return (
        <form className="obj-share-form" onSubmit={share} aria-label={`Use step ${stepIndex + 1} as a shared element`}>
            <p className="t-secondary" style={{ margin: 0 }}>
                A <Term word="shared element">shared element</Term> is named once and used by every step that finds it this way.
            </p>
            <div className="field">
                <label htmlFor={`share-name-${stepIndex}`}>Name for the element</label>
                <input id={`share-name-${stepIndex}`} className="input" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="Leave empty to use a suggested name" />
            </div>
            <label className="obj-check">
                <input type="checkbox" checked={everywhere} onChange={(e) => setEverywhere(e.target.checked)} /> Also use it in other steps that find this element in exactly the same way
            </label>
            {error && <Callout tone="danger">{error}</Callout>}
            <div className="obj-acts">
                <Button type="submit" size="sm" variant="primary" loading={busy}>Use as shared element</Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            </div>
        </form>
    );
}
