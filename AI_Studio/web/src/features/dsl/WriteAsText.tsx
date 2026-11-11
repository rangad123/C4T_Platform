import { useState } from "react";
import { Button, Callout } from "../../components/ui";
import { go, routes } from "../../lib/router";
import { Modal } from "../../components/Modal";
import { dslDiagnostics, starterText, type CreateTextAnswer, type DslDiagnostic, type ParseAnswer } from "./dsl";
import { TextView } from "./TextView";
import "./dsl.css";
import { api, ApiError } from "../../api";
import { describeApiError } from "../../lib/labels";

export function WriteTextDialog({ projectId, onClose }: { projectId: string; onClose: () => void }) {
    const [kind, setKind] = useState<"web" | "api">("web");
    const [text, setText] = useState(starterText("web"));
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [problems, setProblems] = useState<{ forText: string; items: DslDiagnostic[] } | undefined>();
    const [parse, setParse] = useState<{ forText: string; answer: ParseAnswer } | null>(null);

    const knownBroken = !!parse && parse.forText === text && parse.answer.diagnostics.some((d) => d.severity === "error");

    function changeKind(next: "web" | "api") {
        // The example follows the kind only while it is still the example: never over the person's own words.
        if (text === starterText(kind)) setText(starterText(next));
        setKind(next);
    }

    async function create() {
        if (busy) return;
        setBusy(true);
        setError("");
        const sent = text;
        try {
            const r = await api<CreateTextAnswer>(`/projects/${projectId}/dsl-tests`, { method: "POST", body: { text: sent } });
            onClose();
            go(routes.test(r.testId));
        } catch (e) {
            const items = e instanceof ApiError && e.status === 422 ? dslDiagnostics(e.body.diagnostics) : [];
            if (items.length) {
                setProblems({ forText: sent, items });
                setError("The test was not created. Fix the problems listed below and try again. Your text is still here.");
            } else setError(describeApiError(e));
            setBusy(false);
        }
    }

    return (
        <Modal title="Write a test as text" titleId="dsl-new-title" onClose={onClose} wide>
            <div className="dsl-dialog-body dsl-new-dialog">
                <p className="t-secondary">One line per step. The words are fixed, so a test written this way can be reviewed, compared and kept in Git as text. Nothing here uses an AI model.</p>
                <div className="field">
                    <label htmlFor="dsl-new-kind">Starting example</label>
                    <select id="dsl-new-kind" className="input" value={kind} onChange={(e) => changeKind(e.target.value as "web" | "api")}>
                        <option value="web">Web test, in a browser</option>
                        <option value="api">API test, requests only</option>
                    </select>
                </div>
                {error && (
                    <Callout tone="danger" title="That didn’t work">
                        {error}
                    </Callout>
                )}
                <TextView
                    text={text}
                    onChange={setText}
                    filename="new-test.txt"
                    idPrefix="dsl-new"
                    saveProblems={problems}
                    onParsed={(answer, forText) => setParse(answer ? { forText, answer } : null)}
                    actions={
                        <>
                            <Button variant="primary" loading={busy} disabled={knownBroken || busy} onClick={() => void create()}>
                                Create test
                            </Button>
                            <Button disabled={busy} onClick={onClose}>
                                Cancel
                            </Button>
                        </>
                    }
                />
            </div>
        </Modal>
    );
}
