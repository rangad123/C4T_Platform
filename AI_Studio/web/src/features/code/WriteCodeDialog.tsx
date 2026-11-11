import { useState } from "react";
import { Button } from "../../components/ui";
import { FieldHelp } from "../../components/Tooltip";
import { go, routes } from "../../lib/router";
import { Modal } from "../../components/Modal";
import "./code.css";

export function WriteCodeDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
    const [title, setTitle] = useState("");
    const [kind, setKind] = useState<"web" | "api">("web");
    const [category, setCategory] = useState("");
    const [touched, setTouched] = useState(false);
    const t = title.trim();
    const problem = t.length < 3 ? "Give the test a title of at least 3 characters." : t.length > 160 ? "Keep the title under 160 characters." : "";

    return (
        <Modal title="Write a test in code" titleId="code-write-title" onClose={onClose}>
            <form
                className="stack-sm"
                onSubmit={(e) => {
                    e.preventDefault();
                    setTouched(true);
                    if (problem) return;
                    onClose();
                    go(routes.writeCode(projectId, { title: t, kind, category: category.trim() || undefined }));
                }}
            >
                <p className="t-secondary">You write the script yourself. It starts from a short working example, and it is checked before it is saved.</p>
                <div className="field">
                    <label htmlFor="code-write-name">Title</label>
                    <input id="code-write-name" className="input" value={title} maxLength={160} aria-invalid={touched && !!problem} aria-describedby={touched && problem ? "code-write-err" : undefined} onChange={(e) => setTitle(e.target.value)} placeholder="Checkout total is correct" />
                    {touched && problem && (
                        <span className="error-text" id="code-write-err">
                            {problem}
                        </span>
                    )}
                </div>
                <div className="field">
                    <label htmlFor="code-write-kind">Kind of test</label>
                    <select id="code-write-kind" className="input" value={kind} onChange={(e) => setKind(e.target.value as "web" | "api")}>
                        <option value="web">Web test, in a browser</option>
                        <option value="api">API test, requests only</option>
                    </select>
                </div>
                <div className="field">
                    <FieldHelp htmlFor="code-write-cat" label="Area (optional)" help="Test scripts groups tests by area. Tests with the same area are listed together." />
                    <input id="code-write-cat" className="input" value={category} maxLength={80} onChange={(e) => setCategory(e.target.value)} placeholder="Checkout" />
                </div>
                <div className="foot">
                    <Button type="button" onClick={onClose}>
                        Cancel
                    </Button>
                    <Button type="submit" variant="primary">
                        Open the editor
                    </Button>
                </div>
            </form>
        </Modal>
    );
}
