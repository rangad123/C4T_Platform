/**
 * Translation between the protocol's wire shapes and the engine's own shapes.
 *
 * Wire to engine: the task's environment becomes a RunEnv (the same thing the platform gives its own runner), the wire
 * scripts become ScriptInputs whose baselines are local cache paths.
 * Engine to wire: a ScriptRun names its artifacts by local path; the wire names them by the name they were uploaded under.
 * `planUploads` decides those names (unique within the task, always valid protocol names) and `toWireRun` rewrites a run.
 */
import path from "node:path";
import { SafeName, type WireRun, type WireRunEnv } from "../agent-protocol/schema.js";
import type { RunEnv, ScriptRun } from "../engine/validation/runner.js";
import { NameAllocator, sanitizeName } from "./names.js";
import { parseStorageState, secretValuesOf } from "../engine/auth/storage-state.js";

/** The environment the engine's runner takes. "agent" cleanup is the agent's own business: the script only writes its ledger ("platform" mode). */
export function toRunEnv(env: WireRunEnv): RunEnv {
    const { cleanup, ...rest } = env;
    return { ...rest, ...(cleanup ? { cleanup: cleanup === "agent" ? ("platform" as const) : cleanup } : {}) };
}

/** Every secret value of an environment (what the log must never print). */
export function secretsOfEnv(env: WireRunEnv): string[] {
    const out: Array<string | undefined> = [env.credentials?.password, env.credentials?.totpSecret, env.apiToken];
    for (const r of env.roles ?? []) out.push(r.password, r.totpSecret, r.apiToken);
    // The value of an auth header is the secret part ("X-Api-Key: value"); mask both the whole line and the value.
    if (env.apiAuthHeader) {
        out.push(env.apiAuthHeader);
        const i = env.apiAuthHeader.indexOf(":");
        if (i > 0) out.push(env.apiAuthHeader.slice(i + 1).trim());
    }
    for (const v of Object.values(env.vars ?? {})) out.push(v);
    // A Basic sign-in header carries "user:password" in base64: that form is as good as the password.
    for (const c of [env.credentials, ...(env.roles ?? [])]) {
        if (!c?.password || c.password.length < 4) continue;
        const b64 = Buffer.from(`${c.username}:${c.password}`, "utf8").toString("base64");
        out.push(b64, b64.replace(/=+$/, ""));
    }
    // The saved sign-in's cookie and storage values are as good as a password.
    if (env.storageState) {
        try {
            out.push(env.storageState, ...secretValuesOf(parseStorageState(env.storageState)));
        } catch {
            /* a state that does not parse is refused by the run itself */
        }
    }
    return out.filter((s): s is string => Boolean(s));
}

// ── uploads ─────────────────────────────────────────────────────────────────

export interface UploadItem {
    /** Local file. */
    path: string;
    /** Name it is uploaded under (a valid protocol name, unique within the task). */
    name: string;
    /** The artifact kind that named it ("trace" is cleaned of the run's secrets before it is sent); unset for vision shots and baselines. */
    kind?: string;
}

const extOf = (p: string): string => {
    const e = path.extname(p).toLowerCase();
    return /^\.[a-z0-9]{1,8}$/.test(e) ? e : "";
};

/** Which local files a set of runs refers to, and the name each is uploaded under. A file referred to twice is uploaded once. */
export function planUploads(runs: ScriptRun[]): UploadItem[] {
    const names = new NameAllocator();
    const byPath = new Map<string, UploadItem>();
    const add = (file: string, stem: string, ext = extOf(file), kind?: string): void => {
        if (!file || byPath.has(file)) return;
        byPath.set(file, { path: file, name: names.allocate(stem, ext), ...(kind ? { kind } : {}) });
    };
    for (const run of runs) {
        const base = `${sanitizeName(run.testId, 40, "test")}${run.variant ? `-${sanitizeName(run.variant, 30, "v")}` : ""}`;
        for (const a of run.artifacts) add(a.path, `${base}-${a.kind}`, extOf(a.path), a.kind);
        for (const v of run.vision ?? []) add(v.path, `${base}-vision-${v.step}`);
        // A baseline keeps its own name: that name is what the platform stores it under.
        for (const b of run.newBaselines ?? []) add(b.path, path.basename(b.name, path.extname(b.name)), extOf(b.name));
    }
    return [...byPath.values()];
}

/** The result of an upload round: what reached the platform, and what did not (so the run can say so). */
export interface UploadOutcome {
    /** Local path to the name it was uploaded under. */
    uploaded: Map<string, string>;
    /** Local paths that were not uploaded, with a plain reason. */
    skipped: Map<string, string>;
}

const cut = (s: string, n: number): string => (s.length > n ? s.slice(0, n) : s);

/**
 * A ScriptRun in wire form. Files that were not uploaded are left out (an artifact the reviewer cannot open is worse than
 * none); a note says so when something was dropped. Every list is cut to the limit the protocol sets.
 */
export function toWireRun(run: ScriptRun, outcome: UploadOutcome): WireRun {
    const dropped: string[] = [];
    const ref = (p: string): string | undefined => {
        const name = outcome.uploaded.get(p);
        if (!name) dropped.push(outcome.skipped.get(p) ?? "a file could not be uploaded");
        return name;
    };
    const artifacts = run.artifacts.flatMap((a) => {
        const r = ref(a.path);
        return r ? [{ kind: a.kind, ref: r }] : [];
    });
    const vision = (run.vision ?? []).flatMap((v) => {
        const r = ref(v.path);
        return r ? [{ step: v.step, ref: r, ...(v.expected !== undefined ? { expected: v.expected } : {}) }] : [];
    });
    const newBaselines = (run.newBaselines ?? []).flatMap((b) => {
        const r = ref(b.path);
        return r && SafeName.safeParse(b.name).success ? [{ name: b.name, ref: r }] : [];
    });
    const notes = [...(run.notes ?? [])];
    const unique = [...new Set(dropped)];
    if (unique.length > 0) notes.push(cut(`Some files from this run are not attached: ${unique.join("; ")}`, 500));

    return {
        testId: run.testId,
        status: run.status,
        durationMs: Number.isFinite(run.durationMs) ? Math.max(0, run.durationMs) : 0,
        ...(run.error !== undefined ? { error: cut(run.error, 2000) } : {}),
        failedStepIndex: Number.isInteger(run.failedStepIndex) ? run.failedStepIndex : -1,
        steps: run.steps.slice(0, 500).map((s) => ({ index: s.index, title: s.title, status: s.status, ...(s.error !== undefined ? { error: cut(s.error, 800) } : {}) })),
        artifacts: artifacts.slice(0, 50),
        ...(vision.length ? { vision: vision.slice(0, 20) } : {}),
        ...(notes.length ? { notes: notes.slice(0, 50).map((n) => cut(n, 500)) } : {}),
        ...(newBaselines.length ? { newBaselines: newBaselines.slice(0, 50) } : {}),
        responses: run.responses.slice(0, 500).map((r) => ({ method: r.method, path: r.path, status: r.status, ...(r.obs !== undefined ? { obs: r.obs } : {}) })),
        ...(run.metrics?.length ? { metrics: run.metrics.slice(0, 100) } : {}),
        ...(run.variant !== undefined ? { variant: run.variant } : {}),
        ...(run.errorContext ? { errorContext: cut(run.errorContext, 6000) } : {}),
        ...(run.created?.length ? { created: run.created.slice(0, 500) as unknown as Array<Record<string, unknown>> } : {}),
    };
}

/**
 * Mask the run's own secrets in the text a test produced. A failing script can quote a password or token in its error
 * message (a sign-in URL, a response it printed); the platform has the secrets already, but they do not belong in stored text.
 */
export function maskRun(run: WireRun, redact: (text: string) => string): WireRun {
    return {
        ...run,
        ...(run.error !== undefined ? { error: redact(run.error) } : {}),
        steps: run.steps.map((s) => ({ ...s, title: redact(s.title), ...(s.error !== undefined ? { error: redact(s.error) } : {}) })),
        ...(run.notes ? { notes: run.notes.map(redact) } : {}),
        ...(run.errorContext !== undefined ? { errorContext: redact(run.errorContext) } : {}),
    };
}
