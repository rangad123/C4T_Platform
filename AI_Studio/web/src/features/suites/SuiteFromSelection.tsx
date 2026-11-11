import { ListOrdered } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { plural } from "../../lib/format";
import { describeApiError } from "../../lib/labels";
import { go, routes } from "../../lib/router";
import { Modal } from "../../components/Modal";
import type { Suite } from "./suites";

/**
 * "Create suite from selection" in the Test scripts selection bar: names a new suite holding exactly the chosen scripts, in the order
 * they were selected, saves it (POST …/test-suites/from-scripts) and opens it.
 */
export function SuiteFromSelection({ projectId, testIds, canWrite }: { projectId: string; testIds: string[]; /** Building suites changes tests. */ canWrite: boolean }) {
    const [open, setOpen] = useState(false);
    if (!canWrite) return null;
    return (
        <>
            <Button icon={ListOrdered} disabled={testIds.length === 0} tip={testIds.length === 0 ? "Select scripts first." : `A new suite of the ${plural(testIds.length, "selected script")}.`} onClick={() => setOpen(true)}>
                Create suite from selection
            </Button>
            {open && <NameSuite projectId={projectId} testIds={testIds} onClose={() => setOpen(false)} />}
        </>
    );
}

function NameSuite({ projectId, testIds, onClose }: { projectId: string; testIds: string[]; onClose: () => void }) {
    const [name, setName] = useState("");
    const [description, setDescription] = useState("");
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function create() {
        setBusy(true);
        setError("");
        try {
            const s = await api<Suite>(`/projects/${projectId}/test-suites/from-scripts`, { method: "POST", body: { name: name.trim(), ...(description.trim() ? { description: description.trim() } : {}), testIds } });
            go(routes.suite(projectId, s.id));
        } catch (e) {
            setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <Modal
            title="Create suite from selection"
            titleId="suite-from-selection"
            onClose={onClose}
            foot={
                <>
                    <Button variant="ghost" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button variant="primary" form="suite-from-selection-form" type="submit" loading={busy} disabled={!name.trim()}>
                        Create suite
                    </Button>
                </>
            }
        >
            <form
                id="suite-from-selection-form"
                className="stack-sm"
                onSubmit={(e) => {
                    e.preventDefault();
                    if (name.trim()) void create();
                }}
            >
                <p className="t-secondary">The suite holds the {plural(testIds.length, "selected script")} in the order you selected them. You can put them in another order and choose how the suite runs once it is made.</p>
                <div className="field">
                    <label htmlFor="suite-sel-name">Suite name</label>
                    <input id="suite-sel-name" className="input" data-autofocus value={name} maxLength={80} required placeholder="For example: Smoke, Checkout, Full regression" onChange={(e) => setName(e.target.value)} />
                </div>
                <div className="field">
                    <label htmlFor="suite-sel-description">What it is for (optional)</label>
                    <textarea id="suite-sel-description" className="input" rows={2} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
                </div>
                {error && <Callout tone="danger">{error}</Callout>}
            </form>
        </Modal>
    );
}
