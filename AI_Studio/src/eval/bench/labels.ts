/**
 * A person's labels for findings the replays could not verify, bound to the trial they were made for.
 *
 * Test keys (WEB-028) are numbered per project, so every trial has its own WEB-028: a label keyed by `<app>/<testKey>` alone would land on
 * an unrelated finding of another trial. A labels file therefore names, per trial, the platform project each app ran in (the result's
 * `benchmark.apps[].projectId`: created new for every trial, kept across a resume, and inside the result itself), and a label applies only
 * to a result whose app has that project. The result file and its start time are written beside it for a person to read; they do not bind.
 *
 *   { "format": 2, "_APPROVED": "...", "trials": [{ "result": "<results file>", "startedAt": "<run start>",
 *     "projects": { "<app>": "<projectId>" }, "labels": { "<app>/<testKey>": "<defect id>" | "false_positive" } }] }
 *
 * The old format (a flat `{ "<app>/<testKey>": label }`) is refused with a sentence; `bench-report --migrate-labels` binds one to its result.
 */
import { z } from "zod";

const LabelValue = z.string().min(1).max(100);
const LabelTrialSchema = z.object({
    result: z.string().max(1000).optional(),
    startedAt: z.string().max(100).optional(),
    projects: z.record(z.string().min(1).max(100), z.string().min(1).max(100)),
    labels: z.record(z.string().regex(/^[^/]+\/[^/]+$/, "a label key is <app>/<testKey>"), LabelValue),
});
export type LabelTrial = z.infer<typeof LabelTrialSchema>;
const LabelSetSchema = z.object({ format: z.literal(2), trials: z.array(LabelTrialSchema).max(1000) }).passthrough();
export type LabelSet = z.infer<typeof LabelSetSchema>;

const appOf = (key: string) => key.slice(0, key.indexOf("/"));
const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** A labels file's contents, checked; `file` names it in the error. Throws on the old, unbound format and on a bad file. */
export function parseLabels(raw: unknown, file: string): LabelSet {
    if (raw && typeof raw === "object" && !Array.isArray(raw) && !("format" in raw) && Object.keys(raw).some((k) => k.includes("/")))
        throw new Error(
            `${file} is an old labels file: its keys (<app>/<testKey>) do not say which trial they were made for, and every trial has its own WEB-001, WEB-002 and so on. ` +
                `Bind it to the result it was made for first: node scripts/eval.mjs bench-report --migrate-labels ${file} --result <results file> --to <new file>`,
        );
    const parsed = LabelSetSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`${file} is not a labels file: ${parsed.error.issues[0]?.path.join(".")} ${parsed.error.issues[0]?.message}`);
    parsed.data.trials.forEach((t, i) => {
        const unbound = [...new Set(Object.keys(t.labels).map(appOf))].filter((app) => !t.projects[app]);
        if (unbound.length) throw new Error(`${file}: trials[${i}] has labels for ${unbound.join(", ")} but names no project for it, so they cannot be bound to a trial.`);
    });
    return parsed.data;
}

/**
 * The labels that belong to these apps (`<app>/<testKey>` → label, the shape the benchmark applies), and notes for the report: labels made
 * for another trial are left out and counted, and an app with no project id cannot be bound at all.
 */
export function bindLabels(set: LabelSet, apps: ReadonlyArray<{ id: string; projectId?: string | undefined }>): { labels: Record<string, string>; notes: string[] } {
    const labels: Record<string, string> = {};
    const notes: string[] = [];
    const project = new Map(apps.map((a) => [a.id, a.projectId]));
    for (const a of apps) if (!a.projectId) notes.push(`${a.id} has no project id in this result (written before results kept one), so no label can be bound to it; its labels are ignored.`);
    for (const t of set.trials) {
        let ignored = 0;
        for (const [key, label] of Object.entries(t.labels)) {
            const app = appOf(key);
            const here = project.get(app);
            if (here && here === t.projects[app]) labels[key] = label;
            else if (project.has(app) && here) ignored++;
        }
        if (ignored) notes.push(`${plural(ignored, "label")} for another trial ignored (made for ${t.result ?? Object.values(t.projects).join(", ")}).`);
    }
    return { labels, notes };
}

/**
 * An old labels file bound to the one result it was made for, as a new file's contents: every label kept exactly, the `_` notes (the
 * owner's approval) kept, and the result's project per app recorded. Refuses a result that is missing a labelled finding or a project id.
 */
export function migrateLabels(old: unknown, run: { startedAt?: unknown; benchmark?: { apps?: Array<{ id: string; projectId?: string; findings: Array<{ testKey: string }> }> } }, result: string, from: string): LabelSet {
    if (!old || typeof old !== "object" || Array.isArray(old) || "format" in old) throw new Error(`${from} is not an old labels file (a flat { "<app>/<testKey>": label }).`);
    const meta: Record<string, unknown> = {};
    const labels: Record<string, string> = {};
    for (const [k, v] of Object.entries(old)) {
        if (k.startsWith("_")) meta[k] = v;
        else if (/^[^/]+\/[^/]+$/.test(k) && typeof v === "string") labels[k] = v;
        else throw new Error(`${from}: ${k} is neither a label (<app>/<testKey>: text) nor a note (_NAME).`);
    }
    const apps = run.benchmark?.apps ?? [];
    const projects: Record<string, string> = {};
    const missing: string[] = [];
    for (const key of Object.keys(labels)) {
        const app = apps.find((a) => a.id === appOf(key));
        if (!app) throw new Error(`${result} has no app ${appOf(key)}: ${from} was not made for it.`);
        if (!app.projectId) throw new Error(`${result}: ${app.id} has no project id to bind the labels to.`);
        projects[app.id] = app.projectId;
        if (!app.findings.some((f) => f.testKey === key.slice(key.indexOf("/") + 1))) missing.push(key);
    }
    if (missing.length) throw new Error(`${result} has no finding ${missing.join(", ")}: ${from} was not made for this trial. Nothing written.`);
    const trial: LabelTrial = { result, ...(typeof run.startedAt === "string" ? { startedAt: run.startedAt } : {}), projects, labels };
    return { format: 2, ...meta, migratedFrom: from, trials: [trial] };
}
