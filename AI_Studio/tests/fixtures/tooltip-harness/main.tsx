/**
 * A page made only of the shared components (web/src/components/ui.tsx, Tooltip.tsx), so tests/tooltips-ui.test.ts can check the
 * tooltip behaviour in a real browser without depending on any feature page. Built by that test with Vite into a temporary folder.
 */
import { MoreHorizontal, Trash2 } from "lucide-react";
import { StrictMode, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Severity, ValidationStatus } from "../../../web/src/api";
import { Button, JobBadge, Menu, MenuItem, Metric, Ribbon, SeverityBadge, StatusBadge, severityKey, statusKey } from "../../../web/src/components/ui";
import { BadgeKey, FieldHelp, HelpTip, Tooltip } from "../../../web/src/components/Tooltip";
import { help } from "../../../web/src/lib/help";
import "../../../web/src/styles/tokens.css";
import "../../../web/src/styles/base.css";
import "../../../web/src/styles.css";

/** A list with status badges: two statuses and one severity, so its key explains exactly those. */
const LIST: Array<{ name: string; status: ValidationStatus; severity?: Severity }> = [
    { name: "Sign in", status: "FAILED_VALIDATION" },
    { name: "Checkout", status: "VALIDATED" },
    { name: "Search", status: "FAILED_VALIDATION", severity: "low" },
];

function Dialog({ onClose, say }: { onClose: () => void; say: (s: string) => void }) {
    const ref = useRef<HTMLDialogElement>(null);
    useEffect(() => {
        const d = ref.current;
        if (d && !d.open) d.showModal();
    }, []);
    return (
        <dialog ref={ref} aria-labelledby="dlg-title" onClose={onClose} onCancel={() => say("dialog: cancelled")} style={{ width: "min(420px, calc(100vw - 32px))", overflow: "auto" }}>
            <div style={{ display: "grid", gap: 16, padding: 20 }}>
                <h2 className="t-section" id="dlg-title">
                    Save the changes <HelpTip label="saving" text="Saving makes a new version in the test's history; you can go back to any version." />
                </h2>
                <div style={{ display: "flex", gap: 10, justifyContent: "flex-end" }}>
                    <Button onClick={() => ref.current?.close()}>Cancel</Button>
                    <Button
                        variant="primary"
                        tip="Saves your changes and closes this dialog."
                        onClick={() => {
                            say("dialog: saved");
                            ref.current?.close();
                        }}
                    >
                        Save
                    </Button>
                </div>
            </div>
        </dialog>
    );
}

function App() {
    const [out, setOut] = useState("nothing yet");
    const [dialog, setDialog] = useState(false);
    return (
        <main style={{ padding: 24, display: "grid", gap: 24, maxWidth: 900 }}>
            <h1 className="t-page">Tooltip harness</h1>
            <p id="out" role="status">
                {out}
            </p>

            <section aria-label="Actions" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center", paddingTop: 40 }}>
                <Button id="run-all" tip="Starts a run of every test in this project." onClick={() => setOut("run all")}>
                    Run all
                </Button>
                <Button id="export" tip="Downloads every result of the last run as a CSV file." onClick={() => setOut("export")}>
                    Export
                </Button>
                <Button id="delete" variant="ghost" iconOnly icon={Trash2} aria-label="Delete step 1" tip="Removes this step; Undo brings it back." onClick={() => setOut("deleted")} />
                <Menu label="More actions" icon={MoreHorizontal} iconOnly>
                    {(close) => (
                        <>
                            <MenuItem
                                tip="Saves the report as a PDF file on this computer."
                                onClick={() => {
                                    setOut("menu: report");
                                    close();
                                }}
                            >
                                Download report
                            </MenuItem>
                            <MenuItem
                                onClick={() => {
                                    setOut("menu: copy");
                                    close();
                                }}
                            >
                                Copy link
                            </MenuItem>
                        </>
                    )}
                </Menu>
                <Button id="open-dialog" onClick={() => setDialog(true)}>
                    Open dialog
                </Button>
            </section>

            <section aria-label="Statuses" style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}>
                <StatusBadge status="NEEDS_REVIEW" tipFocusable />
                <JobBadge job={{ status: "COMPLETED", error: null, mode: "validate" }} />
                <SeverityBadge severity="high" basis="missing security header" />
            </section>

            <section aria-label="Numbers" className="card">
                <div className="metrics">
                    <Metric value="94%" label="Latest pass rate" tip={help("metric", "latestPassRate")} />
                    <Metric value={3} label="Runs" />
                </div>
                <div style={{ padding: 16 }}>
                    <Ribbon ticks={["pass", "pass", "pass", "attention", "fail", "idle"]} label="3 passing, 1 needs a look, 1 failing, 1 not run yet" />
                </div>
            </section>

            <section aria-label="Settings" className="field" style={{ maxWidth: 360 }}>
                <FieldHelp htmlFor="rps" label="Requests per second" help="The most requests the assessment sends each second. Lower is gentler on the site." hint="Between 1 and 10." />
                <input id="rps" className="input" type="number" defaultValue={2} aria-describedby="rps-hint" />
            </section>

            <section aria-label="Scrolling list">
                <div id="scroller" tabIndex={0} aria-label="Scrolling list" style={{ height: 120, overflow: "auto", border: "1px solid var(--border-default)", borderRadius: 10, padding: 12 }}>
                    <p>One</p>
                    <p>Two</p>
                    <p>Three</p>
                    <Button id="inside" size="sm" tip="This tip is wider than the space the list leaves around the button.">
                        Inside the list
                    </Button>
                    <p>Four</p>
                    <p>Five</p>
                    <p>Six</p>
                    <p>Seven</p>
                </div>
            </section>

            <section aria-label="Disabled with a reason" className="stack-sm">
                {/* Round 21: a disabled Button with a tip stays reachable by keyboard (aria-disabled) and still does nothing, not even submit. */}
                <form
                    id="soft-form"
                    style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "center" }}
                    onSubmit={(e) => {
                        e.preventDefault();
                        setOut("form submitted");
                    }}
                >
                    <label htmlFor="soft-name">Release name</label>
                    <input id="soft-name" className="input" defaultValue="Spring" style={{ maxWidth: 160 }} />
                    <Button type="submit" variant="primary" disabled tip="Save or discard your changes first." onClick={() => setOut("publish pressed")}>
                        Publish
                    </Button>
                    <Button disabled onClick={() => setOut("plain pressed")}>
                        No reason given
                    </Button>
                </form>
            </section>

            <section aria-label="List with badges">
                <div className="row" style={{ gap: 4 }}>
                    <h2 className="t-section">Recent tests</h2>
                    <BadgeKey label="the badges in this list" entries={[...statusKey(LIST.map((t) => t.status)), ...severityKey(LIST.map((t) => t.severity))]} />
                </div>
                <ul>
                    {LIST.map((t) => (
                        <li key={t.name} className="row">
                            {t.name} {t.severity && <SeverityBadge severity={t.severity} />} <StatusBadge status={t.status} />
                        </li>
                    ))}
                </ul>
            </section>

            <section aria-label="Edge" style={{ display: "flex", justifyContent: "flex-end" }}>
                <Tooltip content="A tip at the right edge stays inside the window.">
                    <a id="edge" href="#edge">
                        Edge link
                    </a>
                </Tooltip>
            </section>

            {dialog && <Dialog onClose={() => setDialog(false)} say={setOut} />}
        </main>
    );
}

createRoot(document.getElementById("root")!).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
