import { Search } from "lucide-react";
import { useState } from "react";
import { useFetch } from "../../lib/hooks";
import { routes, type LibrarySection } from "../../lib/router";
import "./library.css";

interface Hit {
    name: string;
    section: LibrarySection;
    href: string;
    kind: string;
}

/** One search across the three shared libraries of Test scripts (reusable steps, shared elements, helpers); it asks only while something is typed. */
export function LibrarySearch({ id }: { id: string }) {
    const [q, setQ] = useState("");
    const needle = q.trim().toLowerCase();
    const steps = useFetch<{ blocks: Array<{ name: string }> }>(needle ? `/projects/${id}/blocks` : null);
    const elements = useFetch<{ elements: Array<{ name: string }> }>(needle ? `/projects/${id}/objects` : null);
    const helpers = useFetch<Array<{ name: string }>>(needle ? `/projects/${id}/helpers` : null);
    const hits: Hit[] = needle
        ? [
              ...(steps.data?.blocks ?? []).map((b): Hit => ({ name: b.name, section: "steps", href: routes.blocks(id, b.name), kind: "Reusable steps" })),
              ...(elements.data?.elements ?? []).map((e): Hit => ({ name: e.name, section: "elements", href: routes.scripts(id, "elements"), kind: "Shared element" })),
              ...(Array.isArray(helpers.data) ? helpers.data : []).map((h): Hit => ({ name: h.name, section: "helpers", href: routes.helpers(id), kind: "Helper" })),
          ].filter((h) => h.name.toLowerCase().includes(needle))
        : [];
    const loading = needle !== "" && (steps.loading || elements.loading || helpers.loading);
    return (
        <div className="lib-search stack-sm">
            <div className="input-wrap">
                <Search size={16} className="lead" aria-hidden />
                <input className="input" type="search" placeholder="Search reusable steps, shared elements and helpers" aria-label="Search shared steps, elements and helpers" value={q} onChange={(e) => setQ(e.target.value)} />
            </div>
            {needle !== "" && (
                <div className="card" role="region" aria-label="Search results" aria-live="polite">
                    {loading ? (
                        <p className="card-pad t-secondary">Searching…</p>
                    ) : hits.length === 0 ? (
                        <p className="card-pad t-secondary">Nothing shared is called “{q.trim()}”.</p>
                    ) : (
                        <ul className="list divided">
                            {hits.map((h) => (
                                <li key={`${h.section}/${h.name}`}>
                                    <a className="list-row" href={h.href}>
                                        <span className="main">
                                            <span className="title">{h.name}</span>
                                            <span className="meta">{h.kind}</span>
                                        </span>
                                    </a>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    );
}
