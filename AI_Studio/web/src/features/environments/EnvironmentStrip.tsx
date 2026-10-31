import { Layers } from "lucide-react";
import { artifactUrl } from "../../api";
import { Badge, SeverityBadge, severityKey } from "../../components/ui";
import { BadgeKey, keyEntries } from "../../components/Tooltip";
import { RelTime } from "../runs/RunTime";
import { cleanReason } from "../../lib/labels";
import { useFetch } from "../../lib/hooks";
import { ENV_HELP, ENV_STATUS, PRODUCTION_WARNING, type EnvStatus, type Environment, type EnvironmentEntry } from "./environments";
import "./environments.css";

/**
 * "Last result per environment" on a test's page: one small card per environment this test has been run against, saying what
 * happened there. Absent until the test has been run against an environment.
 */
export function EnvironmentStrip({ projectId, results }: { projectId: string; results: Record<string, EnvironmentEntry> | undefined }) {
    const names = Object.keys(results ?? {});
    const list = useFetch<{ environments: Environment[] }>(names.length ? `/projects/${projectId}/environments` : null);
    if (names.length === 0 || !results) return null;
    const meta = new Map((list.data?.environments ?? []).map((e) => [e.name, e]));
    return (
        <section className="section stack-sm" aria-label="Results per environment">
            <div className="row">
                <Layers size={18} aria-hidden />
                <h2 className="t-section">Environments</h2>
                <BadgeKey
                    label="the results per environment"
                    entries={[
                        ...keyEntries(["passed", "finding", "failed", "skipped"] as EnvStatus[], names.map((n) => results[n]!.status), (s) => ENV_STATUS[s].label, (s) => ENV_HELP[s]),
                        ...severityKey(names.map((n) => (results[n]!.status === "finding" ? results[n]!.severity?.severity : undefined))),
                        names.some((n) => meta.get(n)?.production) && { word: "Production", text: PRODUCTION_WARNING },
                    ]}
                />
            </div>
            <ul className="env-strip" aria-label="Last result in each environment">
                {names.map((name) => {
                    const r = results[name]!;
                    const s = ENV_STATUS[r.status];
                    const shot = r.artifacts.find((a) => a.kind === "screenshot");
                    return (
                        <li key={name} className={meta.get(name)?.production ? "production" : undefined}>
                            <span className="row">
                                <strong>{name}</strong>
                                {meta.get(name)?.production && <Badge tone="danger" tip={PRODUCTION_WARNING}>Production</Badge>}
                            </span>
                            <span className="row">
                                <Badge tone={s.tone} tip={ENV_HELP[r.status]}>{s.label}</Badge>
                                {r.status === "finding" && r.severity && <SeverityBadge severity={r.severity.severity} basis={r.severity.basis} />}
                                <RelTime iso={r.ranAt} className="t-meta" />
                            </span>
                            {r.reason && r.status !== "passed" && <span className="why">{cleanReason(r.reason.split("\n")[0])}</span>}
                            {shot && (
                                <a href={artifactUrl(shot.id)} target="_blank" rel="noreferrer" className="t-meta">
                                    Screenshot
                                </a>
                            )}
                        </li>
                    );
                })}
            </ul>
        </section>
    );
}
