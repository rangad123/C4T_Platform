import { useFetch } from "../../lib/hooks";
import { CLEANUP_STATUS, leftBehind, runSentence, type TestCleanup } from "./cleanup";

/** One line on a test's page: what the latest run created for this test and what became of it. Absent until it created something. */
export function TestCleanupLine({ testId }: { testId: string }) {
    const data = useFetch<TestCleanup>(`/tests/${testId}/cleanup`);
    const latest = data.data?.latest;
    if (!latest) return null;
    const left = leftBehind(latest.items);
    return (
        <section className="section stack-sm" aria-label="Test data cleanup" data-testid="test-cleanup">
            <h2 className="t-section">Test data</h2>
            <p className="t-secondary">{runSentence(latest.counts).replace("Last run", "The last run")}</p>
            {left.length > 0 && (
                <ul className="bullets">
                    {left.slice(0, 5).map((i) => (
                        <li key={i.id}>
                            <code>
                                POST {i.path}
                            </code>
                            , id <code>{i.recordId}</code>: {CLEANUP_STATUS[i.status].label.toLowerCase()}
                            {i.reason ? `. ${i.reason}` : ""}
                        </li>
                    ))}
                </ul>
            )}
        </section>
    );
}
