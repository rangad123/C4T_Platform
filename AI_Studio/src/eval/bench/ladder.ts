/**
 * The ladder (testing-engine Phase 7 B5, PHASE_5_7_SPEC §7.1 item 1): the benchmark run on several frozen engine trees ("rungs", L0–L4,
 * p57-wave0/LADDER.md) under one harness, and its report.
 *
 * `node scripts/eval.mjs ladder --rungs L0=<tree>,L1=<tree> --apps <id,id> --trials <n> --out <dir> [--port-base <n>] [--plan-only] -- <flags>`
 * runs `node scripts/eval.mjs bench <flags>` in each rung's own tree (its AI_Studio folder), one trial per rung, app and wave, with the
 * same flags everywhere; the ladder adds only --apps, --out, --data-dir, --port-base and --yes. Waves alternate the rung order (forward,
 * then backward), so no rung always runs first. Each trial's folder is `<out>/<rung>/<app>-<wave>` with its platform data in `data/` and
 * `ladder-run.json`: the rung, the tree, its fingerprint (LADDER.md's file hash: a tree copied without git reports `engineCommit:
 * unknown`), the flags and the exit code. A trial whose folder already holds a finished result is not run again, and one the bench
 * stopped is continued with --resume, so a stopped ladder is continued by running the same command. The platform data sits inside the
 * ladder folder, so `--db bench-sqlite` (data under eval/.data-bench only) is not a ladder flag.
 *
 * `bench-report --ladder <out>` reads every trial and gives, per app and rung, the median and range of the brief's metrics (effectiveness.ts
 * for the ones the result lacks) over the trials that measured them, every trial with its status, and the detection verdict of the last
 * rung against the first. Read-only.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { effectiveness, readSavedTrial, type EntryTest } from "./effectiveness.js";
import type { BenchAppResult } from "./schema.js";
import { readResult, trialFile } from "./cli.js";

export interface Rung {
    id: string;
    tree: string;
}
export interface LadderRun {
    rung: string;
    tree: string;
    app: string;
    wave: number;
    out: string;
    dataDir: string;
}

export const LADDER_USAGE = `Usage: node scripts/eval.mjs ladder --rungs <id>=<tree>[,<id>=<tree>...] --apps <id,id> --out <dir> [--trials <n>] [--port-base <n>] [--plan-only] -- <bench flags>
  Runs the benchmark (node scripts/eval.mjs bench <bench flags>) in each rung's tree (its AI_Studio folder): one trial per rung, app and
  wave, waves alternating the rung order. --trials: waves (default 5). The ladder adds --apps, --out, --data-dir, --port-base and --yes.
  Trials already finished in <dir> are not run again. --plan-only prints the trials and runs nothing.
  Report: node scripts/eval.mjs bench-report --ladder <dir>`;
const LADDER_SETS = new Set(["--apps", "--out", "--data-dir", "--port-base", "--yes", "--resume"]);

/** One run per rung, app and wave; odd waves take the rungs in order, even waves backwards. */
export function ladderRuns(rungs: readonly Rung[], apps: readonly string[], trials: number, out: string): LadderRun[] {
    const runs: LadderRun[] = [];
    for (let wave = 1; wave <= trials; wave++)
        for (const r of wave % 2 ? rungs : [...rungs].reverse())
            for (const app of apps) {
                const dir = path.join(out, r.id, `${app}-${wave}`);
                runs.push({ rung: r.id, tree: r.tree, app, wave, out: dir, dataDir: path.join(dir, "data") });
            }
    return runs;
}

/**
 * LADDER.md's tree fingerprint, `find src examples scripts -type f | LC_ALL=C sort | xargs sha256sum | sha256sum | cut -c1-16`, in the
 * tree's folder. The C locale's byte order, so a laptop and the VM agree (the shell's default locale sorts differently).
 */
export function treeFingerprint(tree: string): string {
    const files: string[] = [];
    const walk = (rel: string) => {
        for (const e of fs.readdirSync(path.join(tree, rel), { withFileTypes: true })) {
            const p = `${rel}/${e.name}`;
            if (e.isDirectory()) walk(p);
            else if (e.isFile()) files.push(p);
        }
    };
    for (const top of ["src", "examples", "scripts"]) if (fs.existsSync(path.join(tree, top))) walk(top);
    files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
    const lines = files.map((f) => `${crypto.createHash("sha256").update(fs.readFileSync(path.join(tree, f))).digest("hex")}  ${f}\n`).join("");
    return crypto.createHash("sha256").update(lines).digest("hex").slice(0, 16);
}

const finished = (dir: string): boolean => {
    try {
        trialFile(dir);
        return true;
    } catch {
        return false;
    }
};

export async function ladderMain(argv: string[], deps: { spawn?: (cwd: string, args: string[]) => number; log?: (line: string) => void } = {}): Promise<number> {
    const log = deps.log ?? ((s: string) => console.log(s));
    const spawn = deps.spawn ?? ((cwd: string, args: string[]) => spawnSync(process.execPath, args, { cwd, stdio: "inherit" }).status ?? 1);
    const at = argv.indexOf("--");
    const own = at < 0 ? argv : argv.slice(0, at);
    const flags = at < 0 ? [] : argv.slice(at + 1);
    const fail = (why: string) => (log(`${why}\n${LADDER_USAGE}`), 2);
    const rungs: Rung[] = [];
    let apps: string[] = [];
    let trials = 5;
    let out = "";
    let portBase = 7600;
    let planOnly = false;
    for (let i = 0; i < own.length; i++) {
        const k = own[i]!;
        const v = () => own[++i] ?? "";
        if (k === "--rungs") for (const p of v().split(",").filter(Boolean)) rungs.push({ id: p.slice(0, p.indexOf("=")), tree: path.resolve(p.slice(p.indexOf("=") + 1)) });
        else if (k === "--apps") apps = v().split(",").filter(Boolean);
        else if (k === "--trials") trials = Number(v());
        else if (k === "--out") out = path.resolve(v());
        else if (k === "--port-base") portBase = Number(v());
        else if (k === "--plan-only") planOnly = true;
        else if (k === "--help" || k === "-h") return (log(LADDER_USAGE), 0);
        else return fail(`Unknown option ${k}.`);
    }
    if (!rungs.length || !apps.length || !out) return fail("--rungs, --apps and --out are needed.");
    if (!Number.isInteger(trials) || trials < 1 || trials > 20 || !Number.isInteger(portBase) || portBase < 1024 || portBase > 65000) return fail("--trials is 1 to 20 and --port-base 1024 to 65000.");
    for (const r of rungs) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,15}$/.test(r.id)) return fail(`A rung needs an id of letters and digits (got "${r.id}").`);
        if (!fs.existsSync(r.tree) || !fs.statSync(r.tree).isDirectory()) return fail(`Rung ${r.id}'s tree ${r.tree} does not exist.`);
    }
    if (new Set(rungs.map((r) => r.id)).size !== rungs.length) return fail("Each rung id is given once.");
    const set = flags.filter((f) => LADDER_SETS.has(f));
    if (set.length) return fail(`The ladder sets ${set.join(", ")} itself; leave it out of the bench flags.`);

    const prints = new Map(rungs.map((r) => [r.id, treeFingerprint(r.tree)]));
    let failed = 0;
    for (const r of ladderRuns(rungs, apps, trials, out)) {
        // A trial the bench stopped (rate limit, daily cap) left its state: it is continued, on the same platform data.
        const resume = fs.existsSync(path.join(r.out, "bench-state.json")) ? ["--resume"] : [];
        const args = ["scripts/eval.mjs", "bench", ...flags, "--apps", r.app, "--out", r.out, "--data-dir", r.dataDir, "--port-base", String(portBase), "--yes", ...resume];
        if (finished(r.out)) {
            log(`${r.rung} ${r.app} wave ${r.wave}: finished already, not run again`);
            continue;
        }
        if (planOnly) {
            log(`${r.rung} ${r.app} wave ${r.wave} (tree ${r.tree}, fingerprint ${prints.get(r.rung)}): node ${args.join(" ")}`);
            continue;
        }
        fs.mkdirSync(r.out, { recursive: true });
        const record = { format: 1, rung: r.rung, tree: r.tree, fingerprint: prints.get(r.rung)!, app: r.app, wave: r.wave, flags, startedAt: new Date().toISOString() };
        fs.writeFileSync(path.join(r.out, "ladder-run.json"), `${JSON.stringify({ ...record, exitCode: null }, null, 2)}\n`);
        log(`${r.rung} ${r.app} wave ${r.wave}: running in ${r.tree}`);
        const exitCode = spawn(r.tree, args);
        fs.writeFileSync(path.join(r.out, "ladder-run.json"), `${JSON.stringify({ ...record, exitCode, finishedAt: new Date().toISOString() }, null, 2)}\n`);
        if (exitCode !== 0) failed++;
    }
    if (failed) log(`${failed} trial(s) ended with a non-zero exit code; run the same command to run the unfinished ones again.`);
    return 0;
}

/** Q2's rule: the candidate is better when its minimum beats the baseline's maximum, or the median gap beats the larger range. */
export function verdict(baseline: readonly number[], candidate: readonly number[]): "better" | "worse" | "not shown" | "not measured" {
    if (!baseline.length || !candidate.length) return "not measured";
    const s = (xs: readonly number[]) => ({ min: Math.min(...xs), max: Math.max(...xs), med: median(xs) });
    const [b, c] = [s(baseline), s(candidate)];
    const range = Math.max(b.max - b.min, c.max - c.min);
    if (c.min > b.max || c.med - b.med > range) return "better";
    if (b.min > c.max || b.med - c.med > range) return "worse";
    return "not shown";
}

const median = (xs: readonly number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

interface Trial {
    rung: string;
    app: string;
    wave: number;
    fingerprint: string;
    flags: string[];
    status: string;
    app_?: BenchAppResult;
    effectiveness?: ReturnType<typeof effectiveness>;
}

type Unit = "count" | "rate" | "usd" | "min";
/** The brief's 10 metrics (some in two readings) and the trial's time; undefined: not measured, null: measured without a value. */
const ROWS: Array<[string, Unit, (t: Required<Pick<Trial, "app_" | "effectiveness">>) => number | null | undefined]> = [
    ["Known (effective maximum)", "count", ({ app_: a }) => a.metrics.reachable ?? a.metrics.seeded],
    ["Confirmed (detected)", "count", ({ app_: a }) => a.metrics.detected],
    ["Missed", "count", ({ app_: a }) => a.metrics.missed],
    ["False positives", "count", ({ app_: a }) => a.metrics.falsePositives],
    ["Reproduction rate (replays)", "rate", ({ app_: a }) => a.metrics.reproductionRate],
    ["Reproduction rate (verification)", "rate", ({ effectiveness: e }) => (e.reproduction.verification.measured ? e.reproduction.verification.value : undefined)],
    ["Mutation score", "rate", ({ effectiveness: e }) => (e.mutationScore.measured ? e.mutationScore.value : undefined)],
    ["Time to first confirmed seed (min)", "min", ({ effectiveness: e }) => (e.timeToFirstConfirmedSeed.measured ? (e.timeToFirstConfirmedSeed.value === null ? null : e.timeToFirstConfirmedSeed.value / 60_000) : undefined)],
    ["Cost (USD)", "usd", ({ app_: a }) => a.metrics.cost],
    ["Suite stability", "rate", ({ effectiveness: e }) => (e.stability.measured ? e.stability.value : undefined)],
    ["Workflow coverage (harness)", "rate", ({ effectiveness: e }) => e.workflowCoverage.catalogue.value],
    ["Workflow coverage (coverage record)", "rate", ({ effectiveness: e }) => (e.workflowCoverage.record.measured ? e.workflowCoverage.record.value : undefined)],
    ["Time (min)", "min", ({ app_: a }) => a.metrics.durationMs / 60_000],
];
const fmt = (v: number, u: Unit) => (u === "rate" ? `${Math.round(v * 100)}%` : u === "usd" ? `$${v.toFixed(2)}` : `${+v.toFixed(u === "min" ? 1 : 2)}`);

/** Every trial of a ladder folder: `<out>/<rung>/<app>-<wave>/ladder-run.json`, with its finished result when it has one. */
export function ladderTrials(out: string): Trial[] {
    const trials: Trial[] = [];
    for (const rung of fs.readdirSync(out, { withFileTypes: true }).filter((d) => d.isDirectory()))
        for (const run of fs.readdirSync(path.join(out, rung.name), { withFileTypes: true }).filter((d) => d.isDirectory())) {
            const dir = path.join(out, rung.name, run.name);
            const recFile = path.join(dir, "ladder-run.json");
            if (!fs.existsSync(recFile)) continue;
            const rec = JSON.parse(fs.readFileSync(recFile, "utf8")) as { rung: string; app: string; wave: number; fingerprint: string; flags: string[]; exitCode: number | null };
            const t: Trial = { rung: rec.rung, app: rec.app, wave: rec.wave, fingerprint: rec.fingerprint, flags: rec.flags, status: `not finished (exit ${rec.exitCode ?? "none: still running or killed"})` };
            if (finished(dir)) {
                const file = trialFile(dir);
                const b = readResult(file);
                const a = b.apps.find((x) => x.id === rec.app);
                const raw = JSON.parse(fs.readFileSync(file, "utf8")) as { entries?: Array<{ projectId?: string; tests?: EntryTest[] }> };
                if (a) {
                    const data = path.join(dir, "data");
                    const saved = a.projectId && fs.existsSync(path.join(data, "platform.db")) ? readSavedTrial(data, a.projectId) : undefined;
                    t.app_ = a;
                    t.effectiveness = effectiveness(a, saved, raw.entries?.find((e) => e.projectId === a.projectId)?.tests);
                    t.status = a.status;
                } else t.status = `the result has no ${rec.app}`;
            }
            trials.push(t);
        }
    return trials.sort((a, b) => a.app.localeCompare(b.app) || a.rung.localeCompare(b.rung) || a.wave - b.wave);
}

export function ladderReport(out: string): string {
    const trials = ladderTrials(out);
    const L = [`# Ladder: ${out}`, ""];
    const flagSets = new Set(trials.map((t) => JSON.stringify(t.flags)));
    L.push(flagSets.size > 1 ? `**The trials did not all use the same harness flags:** ${[...flagSets].join(" | ")}` : `Harness flags: ${trials[0] ? trials[0].flags.join(" ") || "(none)" : "(no trial)"}`, "");
    for (const app of [...new Set(trials.map((t) => t.app))]) {
        const rungs = [...new Set(trials.filter((t) => t.app === app).map((t) => t.rung))];
        L.push(`## ${app}`, "", "Median (range) [trials that measured it / trials]; unfinished trials count in the second number only.", "", `| Metric | ${rungs.join(" | ")} |`, `|---|${rungs.map(() => "---|").join("")}`);
        const of = (rung: string) => trials.filter((t) => t.app === app && t.rung === rung);
        const values = (rung: string, get: (typeof ROWS)[number][2]) => of(rung).flatMap((t) => (t.app_ && t.effectiveness ? [get({ app_: t.app_, effectiveness: t.effectiveness })] : []));
        for (const [label, unit, get] of ROWS) {
            const cells = rungs.map((rung) => {
                const all = values(rung, get);
                const nums = all.filter((v): v is number => typeof v === "number");
                if (!nums.length) return all.some((v) => v === null) ? `none [0/${of(rung).length}]` : "not measured";
                return `${fmt(median(nums), unit)} (${fmt(Math.min(...nums), unit)}–${fmt(Math.max(...nums), unit)}) [${nums.length}/${of(rung).length}]`;
            });
            L.push(`| ${label} | ${cells.join(" | ")} |`);
        }
        if (rungs.length > 1) {
            const detected = (rung: string) => values(rung, ROWS[1]![2]).filter((v): v is number => typeof v === "number");
            L.push("", `Detection, ${rungs.at(-1)} against ${rungs[0]} (${app}): ${verdict(detected(rungs[0]!), detected(rungs.at(-1)!))} (rule: the candidate's minimum above the baseline's maximum, or the median gap above the larger range).`);
        }
        L.push("");
    }
    L.push("## Trials", "", "| Rung | Wave | App | Fingerprint | Status |", "|---|---|---|---|---|", ...trials.map((t) => `| ${t.rung} | ${t.wave} | ${t.app} | ${t.fingerprint} | ${t.status} |`));
    return L.join("\n");
}
