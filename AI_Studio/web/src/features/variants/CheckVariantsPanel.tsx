import { MonitorSmartphone } from "lucide-react";
import { useState } from "react";
import { api } from "../../api";
import { Button, Callout } from "../../components/ui";
import { describeApiError } from "../../lib/labels";
import { plural } from "../../lib/format";
import { VariantPicker } from "./VariantPicker";
import { variantLabel } from "./variants";
import "./variants.css";

interface Started {
    tests: Array<{ id: string; testId: string }>;
    skipped: Array<{ testId: string; reason: string }>;
    unavailable: Array<{ variant: string; reason: string }>;
    variants: string[];
}

/** Tests tab → ⋯ More actions → "Check other browsers & screen sizes": pick where to repeat the validated web tests. */
export function CheckVariantsPanel({ projectId, onStarted, onClose }: { projectId: string; onStarted: () => void; onClose: () => void }) {
    const [picked, setPicked] = useState<string[]>([]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");
    const [started, setStarted] = useState<Started | null>(null);

    async function start() {
        setBusy(true);
        setError("");
        setStarted(null);
        try {
            const res = await api<Started>(`/projects/${projectId}/variants`, { method: "POST", body: { variants: picked } });
            setStarted(res);
            onStarted();
        } catch (e) {
            setError(describeApiError(e));
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card card-pad stack-sm" aria-label="Check other browsers and screen sizes">
            <div className="row">
                <MonitorSmartphone size={18} aria-hidden />
                <h2 className="t-section">Check other browsers &amp; screen sizes</h2>
                <span className="spacer" />
                <Button size="sm" variant="ghost" onClick={onClose}>Close</Button>
            </div>
            <p className="t-secondary">We’ll repeat your passing web tests on the browsers and screen sizes you pick and show where they break. Your tests’ own results don’t change.</p>
            <VariantPicker value={picked} onChange={setPicked} disabled={busy} />
            <p className="t-meta">Accessibility, visual, API and not-yet-passing tests aren’t repeated.</p>
            {error && <Callout tone="danger" title="We couldn’t start the check">{error}</Callout>}
            {started && (
                <Callout tone="success" title="Checking now">
                    {plural(started.tests.length, "test")} will be checked on {started.variants.map(variantLabel).join(", ")}. This takes a minute or two; results appear on each test and in the list.
                    {started.skipped.length ? ` ${plural(started.skipped.length, "test")} won’t be repeated (accessibility, visual, API or not passing yet).` : ""}
                    {started.unavailable.length ? ` ${started.unavailable.map((u) => variantLabel(u.variant)).join(", ")} can’t run on this server and will be marked “couldn’t run”.` : ""}
                </Callout>
            )}
            <div className="row">
                <Button variant="primary" loading={busy} disabled={busy || picked.length === 0} onClick={() => void start()}>
                    Run checks
                </Button>
            </div>
        </section>
    );
}
