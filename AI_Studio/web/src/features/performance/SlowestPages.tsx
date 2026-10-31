import { Gauge } from "lucide-react";
import { useFetch } from "../../lib/hooks";
import { routes } from "../../lib/router";
import { formatValue } from "./performance";
import "./performance.css";

interface Slowest {
    testId: string;
    title: string;
    testKey: string;
    metric: string;
    value: number;
    unit: string;
    budget: number | null;
}

/** The slowest measured pages on the project Overview. Renders nothing until page speed has been measured. */
export function SlowestPages({ projectId }: { projectId: string }) {
    const perf = useFetch<{ slowest: Slowest[] }>(`/projects/${projectId}/performance`);
    const rows = perf.data?.slowest ?? [];
    if (rows.length === 0) return null;
    return (
        <section data-testid="slowest-pages">
            <div className="section-head">
                <h2 className="t-section">Slowest pages</h2>
                <span className="t-meta">Time until the main content appears</span>
            </div>
            <ul className="card list divided">
                {rows.map((r) => (
                    <li key={r.testId}>
                        <a className="list-row" href={routes.test(r.testId)}>
                            <Gauge size={16} aria-hidden />
                            <span className="main">
                                <span className="title">{r.title}</span>
                                <span className="meta">{r.testKey}</span>
                            </span>
                            <span className="speed-value">{formatValue(r)}</span>
                            {r.budget !== null && <span className={`speed-budget ${r.value > r.budget ? "over" : ""}`}>{r.value > r.budget ? `over the ${formatValue({ ...r, value: r.budget })} budget` : "within budget"}</span>}
                        </a>
                    </li>
                ))}
            </ul>
        </section>
    );
}
