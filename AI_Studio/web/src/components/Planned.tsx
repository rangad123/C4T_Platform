import type { ReactNode } from "react";
import { Badge } from "./ui";

/**
 * A place or section whose backend is not built yet (decision D-28: the new navigation is reviewable before its data exists).
 * It says what will be here, which phase of docs/product-restructure/IMPLEMENTATION_ROADMAP.md builds it, and what to use until
 * then. It never shows invented data: a reviewer must not mistake a plan for a working feature.
 */
export function Planned({ title, phase, will, today, testId }: { title: string; phase: string; will: string[]; today?: ReactNode; testId?: string }) {
    return (
        <section className="card card-pad stack-sm" data-testid={testId ?? "planned"} aria-label={`${title}: planned`}>
            <div className="row" style={{ gap: 12, alignItems: "center", flexWrap: "wrap" }}>
                <h2 className="t-section">{title}</h2>
                <Badge tone="info" tip="Not built yet. This is where it will be, so the layout can be reviewed now.">
                    Planned · {phase}
                </Badge>
            </div>
            <div className="stack-sm">
                <p className="t-card">What will be here</p>
                <ul className="planned-list">
                    {will.map((w) => (
                        <li key={w}>{w}</li>
                    ))}
                </ul>
            </div>
            {today && (
                <div className="stack-sm">
                    <p className="t-card">Until then</p>
                    <div className="t-secondary">{today}</div>
                </div>
            )}
        </section>
    );
}
