import { useFetch } from "../../lib/hooks";
import { PRODUCTION_WARNING, type Environment } from "./environments";
import "./environments.css";

/** What a run is aimed at: the project's own address (the default), or one of its named environments. */
export interface RunTarget {
    environment: string;
    confirmProduction: boolean;
}
export const MAIN_TARGET: RunTarget = { environment: "", confirmProduction: false };

/**
 * A small "Run on" picker next to "Run again". Absent unless the project has environments, so projects that don't use them see nothing new.
 * A production environment cannot be run without ticking its confirmation.
 */
export function EnvironmentPicker({ projectId, value, onChange, disabled }: { projectId: string; value: RunTarget; onChange: (v: RunTarget) => void; disabled?: boolean }) {
    const list = useFetch<{ environments: Environment[] }>(`/projects/${projectId}/environments`);
    const envs = list.data?.environments ?? [];
    if (envs.length === 0) return null;
    const chosen = envs.find((e) => e.name === value.environment);
    return (
        <span className="env-picker">
            <label className="sr-only" htmlFor="run-on">Run on</label>
            <select id="run-on" className="input" value={value.environment} disabled={disabled} onChange={(e) => onChange({ environment: e.target.value, confirmProduction: false })}>
                <option value="">Project address</option>
                {envs.map((e) => (
                    <option key={e.id} value={e.name}>
                        {e.name}
                        {e.production ? " (production)" : ""}
                    </option>
                ))}
            </select>
            {chosen?.production && (
                <label className="check env-production">
                    <input type="checkbox" checked={value.confirmProduction} disabled={disabled} onChange={(e) => onChange({ ...value, confirmProduction: e.target.checked })} />
                    <span>
                        <span className="title">Yes, run on production</span>
                        {/* A warning stays visible text (it used to be only a hover title). */}
                        <span className="hint">{PRODUCTION_WARNING}</span>
                    </span>
                </label>
            )}
        </span>
    );
}

/** The names of the project's production environments, for knowing when a confirmation is needed. */
export function useProductionNames(projectId: string | null): string[] {
    const list = useFetch<{ environments: Environment[] }>(projectId ? `/projects/${projectId}/environments` : null);
    return (list.data?.environments ?? []).filter((e) => e.production).map((e) => e.name);
}

/** Whether the chosen target may be run right now (a production target needs its confirmation). */
export const canRun = (v: RunTarget, productionNames: string[]) => !v.environment || !productionNames.includes(v.environment) || v.confirmProduction;
