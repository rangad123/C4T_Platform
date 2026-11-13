import { Map as MapIcon } from "lucide-react";
import { Disclosure } from "../../components/ui";
import { plural } from "../../lib/format";
import { useFetch } from "../../lib/hooks";

interface Screen {
    key: string;
    heading: string;
    paths: string[];
    roles?: string[];
}
interface Transition {
    from: string;
    to: string;
    action: string;
    covered?: boolean;
    roles?: string[];
}
interface ScreenMap {
    screens: Screen[];
    transitions: Transition[];
    conditional: Array<{ screen: string; when: string; shows: string[] }>;
}

/**
 * The exploration's map of screens: how many screens and transitions it found and how many of those transitions a test follows.
 * A plain list grouped by screen (engine/screenmap/map.ts builds it). Nothing is shown for an exploration made before maps existed.
 */
export function ScreenMapCard({ projectId }: { projectId: string }) {
    const model = useFetch<{ screenMap?: ScreenMap } | null>(`/projects/${projectId}/application-model`);
    const map = model.data?.screenMap;
    if (!map || !map.screens.length) return null;
    const covered = map.transitions.filter((t) => t.covered).length;
    const name = (key: string) => map.screens.find((s) => s.key === key)?.paths[0] ?? key;
    return (
        <section data-testid="screen-map" aria-label="Screens found">
            <div className="section-head">
                <MapIcon size={18} aria-hidden />
                <h2 className="t-section">Screens found</h2>
            </div>
            <div className="card card-pad stack-sm">
                <p data-testid="screen-map-counts">
                    Screens found: {map.screens.length}, transitions: {map.transitions.length}, covered by tests: {covered}
                </p>
                <Disclosure label="See the screens">
                    <ul className="stack-sm">
                        {map.screens.map((s) => {
                            const out = map.transitions.filter((t) => t.from === s.key);
                            const cond = map.conditional.filter((c) => c.screen === s.key);
                            return (
                                <li key={s.key}>
                                    <strong>{s.paths[0] ?? s.key}</strong>
                                    {s.heading ? <span className="t-secondary"> · {s.heading}</span> : null}
                                    {s.roles?.length ? <span className="t-meta"> · reached as {s.roles.join(", ")}</span> : null}
                                    {out.length > 0 && (
                                        <ul>
                                            {out.map((t) => (
                                                <li key={`${t.to}|${t.action}`} className="t-secondary">
                                                    “{t.action}” leads to {name(t.to)}
                                                    {t.covered ? " (a test follows it)" : ""}
                                                </li>
                                            ))}
                                        </ul>
                                    )}
                                    {cond.length > 0 && (
                                        <p className="t-meta">
                                            {plural(cond.length, "form choice")} shows more fields: {cond.map((c) => `${c.when} → ${c.shows.join(", ")}`).join("; ")}
                                        </p>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                </Disclosure>
            </div>
        </section>
    );
}
