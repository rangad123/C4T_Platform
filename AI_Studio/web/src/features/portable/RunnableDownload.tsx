import { FolderArchive } from "lucide-react";
import { useState } from "react";
import { downloadFrom } from "../../api";
import { Button } from "../../components/ui";
import { describeApiError } from "../../lib/labels";

/**
 * "Run it on your computer": one test as a zip that runs on its own (GET /api/tests/:id/download): the script, the exact package
 * versions it runs with, a lockfile and a README with the three steps. See docs/features/portable-code-tests.md.
 */
export function RunnableDownload({ testId, testKey, phone = false }: { testId: string; testKey: string; /** A phone test: it runs with Taqwright and needs an emulator or phone, so the steps differ. */ phone?: boolean }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState("");

    async function download() {
        setBusy(true);
        setError("");
        try {
            await downloadFrom(`/tests/${encodeURIComponent(testId)}/download`, `${testKey}.zip`);
        } catch (e) {
            setError(`The download did not work: ${describeApiError(e)}. Try again.`);
        } finally {
            setBusy(false);
        }
    }

    return (
        <section className="card stack-sm" style={{ padding: "16px 20px" }} aria-labelledby="runnable-title">
            <h2 className="t-card" id="runnable-title">
                Run it on your own computer
            </h2>
            <p className="t-secondary">
                A zip with this test, the exact package versions it runs with and a README.{" "}
                {phone ? (
                    <>
                        In the unpacked folder: <code>npm ci</code>, then <code>npm run test:phone</code> with an emulator or phone ready (the README says which settings it needs).
                    </>
                ) : (
                    <>
                        In the unpacked folder: <code>npm ci</code>, <code>npx playwright install</code>, <code>npx playwright test</code>. Node.js 20 or newer is all it needs.
                    </>
                )}
            </p>
            <div className="row">
                <Button icon={FolderArchive} loading={busy} onClick={() => void download()}>
                    Download ready to run
                </Button>
            </div>
            {error && (
                <p className="t-meta" role="alert" style={{ color: "var(--status-error-fg)" }}>
                    {error}
                </p>
            )}
        </section>
    );
}
