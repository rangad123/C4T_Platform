import { useState } from "react";
import { Button } from "../../components/ui";
import { WriteTestDialog } from "./WriteTestDialog";
import "./authoring.css";

/** On a test's page: the sentence the test was built from, and a way to change the words and rebuild it. */
export function PlainOrigin({ testId, projectId, description, onRebuilt }: { testId: string; projectId: string; description: string; onRebuilt: () => void }) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <div className="plain-origin" data-testid="plain-origin">
                <span className="t-meta">Written in plain English</span>
                <q>{description}</q>
                <Button size="sm" onClick={() => setOpen(true)}>Change the description</Button>
            </div>
            {open && <WriteTestDialog projectId={projectId} rewrite={{ testId, description }} onClose={() => setOpen(false)} onDone={onRebuilt} />}
        </>
    );
}
