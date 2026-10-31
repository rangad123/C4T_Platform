import { ListPlus } from "lucide-react";
import { useState } from "react";
import { Button, Callout } from "../../components/ui";
import { FieldHelp } from "../../components/Tooltip";
import { go, routes } from "../../lib/router";
import { Modal } from "../code/Modal";
import { bapi, errorText } from "./builder";
import "./builder.css";

/** "Build a test" on the Tests page: name it, pick the kind, and the step editor opens with the first step already in place. */
export function BuildTestButton({ projectId }: { projectId: string }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button icon={ListPlus} onClick={() => setOpen(true)}>
                Build a test
            </Button>
            {open && <BuildTestDialog projectId={projectId} onClose={() => setOpen(false)} />}
        </>
    );
}

export function BuildTestDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
    const [title, setTitle] = useState("");
    const [kind, setKind] = useState<"web" | "api">("web");
    const [category, setCategory] = useState("");
    const [touched, setTouched] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const t = title.trim();
    const problem = t.length < 3 ? "Give the test a title of at least 3 characters." : t.length > 160 ? "Keep the title under 160 characters." : "";

    async function create() {
        setTouched(true);
        if (problem || busy) return;
        setBusy(true);
        setError("");
        try {
            const r = await bapi<{ testId: string }>(`/projects/${projectId}/built-tests`, { method: "POST", body: { title: t, kind, ...(category.trim() ? { category: category.trim() } : {}) } });
            onClose();
            go(routes.builder(r.testId));
        } catch (e) {
            setError(errorText(e));
            setBusy(false);
        }
    }

    return (
        <Modal title="Build a test" titleId="bld-new-title" onClose={onClose}>
            <form
                className="stack-sm bld-new-dialog"
                onSubmit={(e) => {
                    e.preventDefault();
                    void create();
                }}
            >
                <p className="t-secondary">You add the steps one by one. The script is made for you and checked when you save.</p>
                <div className="field">
                    <label htmlFor="bld-new-name">Title</label>
                    <input id="bld-new-name" className="input" value={title} maxLength={160} aria-invalid={touched && !!problem} aria-describedby={touched && problem ? "bld-new-err" : undefined} onChange={(e) => setTitle(e.target.value)} placeholder="Checkout total is correct" />
                    {touched && problem && (
                        <span className="error-text" id="bld-new-err">
                            {problem}
                        </span>
                    )}
                </div>
                <div className="field">
                    <label htmlFor="bld-new-kind">Kind of test</label>
                    <select id="bld-new-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as "web" | "api")}>
                        <option value="web">Web test, in a browser</option>
                        <option value="api">API test, requests only</option>
                    </select>
                </div>
                <div className="field">
                    <FieldHelp htmlFor="bld-new-cat" label="Area (optional)" help="The Tests page groups tests by area. Tests with the same area are listed together." />
                    <input id="bld-new-cat" className="input" value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} placeholder="Checkout" />
                </div>
                {error && <Callout tone="danger">{error}</Callout>}
                <div className="foot">
                    <Button type="button" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="primary" loading={busy}>
                        Start building
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
