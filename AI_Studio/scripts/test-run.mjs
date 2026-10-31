// Test tiers with a per-file time report and an honest retry policy.
//   node scripts/test-run.mjs fast|browser|phone|release [--no-retry] [--report <dir>] [--files a,b,...]
// npm scripts: test:fast (vitest directly), test:browser, test:phone, test:release.
//
// - Every vitest run goes through scripts/with-lock.mjs "browser" (re-entrant), so builders and this runner take turns on the machine.
// - fast runs the fast config (parallel); browser and phone run their files one at a time; release runs fast, then browser + phone.
// - A file with a failure is run once more on its own. A test that passes only on that retry is FLAKY: it is listed in the report and
//   fails the run unless tests/flaky-allowlist.json allows it (reason + expiry date, at most 90 days ahead). A test that fails twice is
//   a failure. Errors outside a test (a hook, vitest's "Unhandled errors", a crashed run) are failures too. The report lists everything.
// Exit code: 0 all passed (allowed flaky tests only), 1 a failure or a flaky test that is not allowed, 2 the runner itself could not work.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ROOT, tierOf, tiers } from "./test-tiers.mjs";
import { allowedBy, classify, filesOf, filesToRetry, gate, readAllowlist } from "./test-verdict.mjs";

const args = process.argv.slice(2);
const tier = args[0];
if (!["fast", "browser", "phone", "release"].includes(tier ?? "")) {
    console.error("usage: node scripts/test-run.mjs fast|browser|phone|release [--no-retry] [--report <dir>] [--files a,b,...]");
    process.exit(2);
}
const opt = (n) => {
    const i = args.indexOf(n);
    return i >= 0 ? args[i + 1] : undefined;
};
const retry = !args.includes("--no-retry");
const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const reportDir = path.resolve(ROOT, opt("--report") ?? path.join(".scratch", "test-reports"));
const work = path.join(reportDir, `${tier}-${stamp}`);
fs.mkdirSync(work, { recursive: true });
const VITEST = path.join(ROOT, "node_modules", "vitest", "vitest.mjs");
const LOCK = path.join(ROOT, "scripts", "with-lock.mjs");
const t = tiers();
const only = opt("--files")?.split(",").map((f) => f.trim().replace(/\\/g, "/")).filter(Boolean);

const rel = (abs) => path.relative(ROOT, abs).replace(/\\/g, "/");
const mb = () => Math.round(os.freemem() / 1048576);
const fmt = (ms) => (ms >= 60_000 ? `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s` : `${(ms / 1000).toFixed(1)} s`);

/** One vitest process (under the lock): its JSON results, exit code, wall time, free memory, and the files vitest blamed for unhandled errors. */
function vitest(label, vitestArgs) {
    const json = path.join(work, `${label}.json`);
    const logFile = path.join(work, `${label}.log`);
    const log = fs.createWriteStream(logFile);
    const started = Date.now();
    const freeBefore = mb();
    console.log(`\n[test-run] ${label}: vitest run ${vitestArgs.length > 6 ? `${vitestArgs.length} files` : vitestArgs.join(" ")}`);
    return new Promise((resolve) => {
        const child = spawn(process.execPath, [LOCK, "browser", "--", process.execPath, VITEST, "run", ...vitestArgs, "--reporter=default", "--reporter=json", `--outputFile.json=${json}`], {
            cwd: ROOT,
            stdio: ["ignore", "pipe", "pipe"],
            env: { ...process.env, FORCE_COLOR: "0" },
        });
        const both = (chunk, out) => {
            out.write(chunk);
            log.write(chunk);
        };
        child.stdout.on("data", (c) => both(c, process.stdout));
        child.stderr.on("data", (c) => both(c, process.stderr));
        child.on("error", (e) => both(Buffer.from(`[test-run] could not start vitest: ${e.message}\n`), process.stderr));
        child.on("close", (code) => {
            log.end(() => {
                let results;
                try {
                    results = JSON.parse(fs.readFileSync(json, "utf8"));
                } catch {
                    results = undefined;
                }
                const text = fs.readFileSync(logFile, "utf8");
                // vitest names the file an unhandled error came from: This error originated in "tests/x.test.ts" test file.
                const unhandled = [...new Set([...text.matchAll(/originated in "([^"]+\.test\.ts)" test file/g)].map((m) => m[1].replace(/\\/g, "/")))];
                const unhandledCount = /Unhandled Error/i.test(text) ? Math.max(1, Number(/(\d+) unhandled errors?/i.exec(text)?.[1] ?? 1)) : 0;
                resolve({ label, code: code ?? 1, results, wallMs: Date.now() - started, freeBefore, freeAfter: mb(), log: rel(logFile), unhandled, unhandledCount });
            });
        });
    });
}

async function main() {
    const startedAt = new Date();
    const runs = [];
    const pick = (files) => (only ? files.filter((f) => only.includes(f)) : files);
    const fastFiles = tier === "fast" || tier === "release" ? pick(t.fast) : [];
    if (fastFiles.length) runs.push(await vitest("fast", ["--config", "vitest.fast.config.ts", ...(only ? fastFiles : [])]));
    const sequential = tier === "browser" ? t.browser : tier === "phone" ? t.phone : tier === "release" ? [...t.browser, ...t.phone] : [];
    const seqFiles = pick(sequential);
    if (seqFiles.length) runs.push(await vitest(tier === "release" ? "browser-and-phone" : tier, seqFiles));
    if (!runs.length) {
        console.error("[test-run] no test file matched.");
        return 2;
    }

    const first = new Map();
    const runProblems = [];
    for (const r of runs) {
        if (!r.results) runProblems.push(`The ${r.label} run produced no results (exit code ${r.code}); see ${r.log}.`);
        else if (r.code !== 0 && ![...filesOf(r.results, rel).values()].some((f) => f.failed.length || f.fileError) && r.unhandledCount === 0)
            runProblems.push(`The ${r.label} run exited with code ${r.code} although every test passed; see ${r.log}.`);
        for (const [k, v] of filesOf(r.results, rel)) first.set(k, v);
    }
    const unhandled = runs.flatMap((r) => r.unhandled);
    for (const r of runs) if (r.unhandledCount > 0 && r.unhandled.length === 0) runProblems.push(`The ${r.label} run had ${r.unhandledCount} unhandled error(s) that vitest did not tie to a file; see ${r.log}.`);
    const notRun = [...fastFiles, ...seqFiles].filter((f) => !first.has(f) && runs.some((r) => r.results));

    const second = new Map();
    const retryRuns = [];
    if (retry) {
        for (const file of filesToRetry(first, unhandled, notRun)) {
            const r = await vitest(`retry-${path.basename(file, ".test.ts")}`, tierOf(file, t) === "fast" ? ["--config", "vitest.fast.config.ts", file] : [file]);
            retryRuns.push(r);
            const got = r.results ? filesOf(r.results, rel).get(file) : undefined;
            second.set(file, got ? { ...got, unhandled: r.unhandledCount > 0 } : { file, ms: r.wallMs, tests: 0, passed: 0, skipped: 0, failed: [], fileError: `no result on the retry (exit code ${r.code})`, noResult: true });
        }
    }
    const { failures, flaky } = classify({ first, second, unhandled, notRun });
    for (const p of runProblems) failures.push({ file: "(run)", test: "(run)", detail: p, retried: false });

    let parsed;
    let readProblem;
    try {
        parsed = JSON.parse(fs.readFileSync(path.join(ROOT, "tests", "flaky-allowlist.json"), "utf8"));
    } catch (e) {
        readProblem = `tests/flaky-allowlist.json could not be read (${e.message}); no flaky test is allowed.`;
    }
    const allow = readAllowlist(parsed);
    if (readProblem) allow.problems.unshift(readProblem);
    const verdict = gate({ failures, flaky }, allow.valid);

    // ── report ──
    const files = [...first.values()].sort((x, y) => y.ms - x.ms);
    const totalTests = files.reduce((s, f) => s + f.tests, 0);
    const wall = runs.reduce((s, r) => s + r.wallMs, 0);
    const retryWall = retryRuns.reduce((s, r) => s + r.wallMs, 0);
    const L = [];
    L.push(`# Test run: ${tier}`, "");
    L.push(`**${verdict.ok ? "PASSED" : "FAILED"}**. Started ${startedAt.toISOString()} (${os.cpus().length} CPUs, ${Math.round(os.totalmem() / 1073741824)} GB memory).`, "");
    L.push(`- Files with results: ${files.length}${notRun.length ? `; without results: ${notRun.length}` : ""}. Tests: ${totalTests}.`);
    L.push(`- Time: ${fmt(wall)}${retryRuns.length ? `, plus ${fmt(retryWall)} for ${retryRuns.length} retried file(s)` : ""}.`);
    for (const r of runs) L.push(`- ${r.label}: ${fmt(r.wallMs)}, exit code ${r.code}, free memory ${r.freeBefore} MB before and ${r.freeAfter} MB after, log \`${r.log}\`.`);
    L.push(`- Failures: ${failures.length}. Flaky: ${flaky.length} (allowed by tests/flaky-allowlist.json: ${verdict.allowed.length}).`, "");
    L.push("Low free memory slows every browser file: compare the free memory above with an earlier report before blaming a test.", "");
    if (failures.length) {
        L.push("## Failures", "");
        for (const f of failures) L.push(`- ${f.file} > ${f.test}${f.detail ? `: ${f.detail}` : ""}${f.retried ? " (failed again on its retry)" : ""}`);
        L.push("");
    }
    if (flaky.length) {
        L.push("## Flaky tests", "", "Each failed on one attempt and passed on the other. One that is not allowed fails this run: fix the cause, or add a reviewed entry with a reason and an expiry date.", "");
        for (const f of flaky) {
            const a = allowedBy(allow.valid, f);
            L.push(`- ${a ? `allowed until ${a.expires}` : "NOT ALLOWED"}: ${f.file} > ${f.test}${f.detail ? ` (${f.detail})` : ""}`);
        }
        L.push("");
    }
    if (allow.problems.length) L.push("## Allow-list problems", "", ...allow.problems.map((p) => `- ${p}`), "");
    if (t.missingFast.length) L.push(`Listed in vitest.fast.config.ts but not found: ${t.missingFast.join(", ")}.`, "");
    L.push("## Time per file (slowest first)", "", "| Seconds | Tests | Tier | File |", "|---:|---:|---|---|");
    for (const f of files) L.push(`| ${(f.ms / 1000).toFixed(1)} | ${f.tests}${f.skipped ? ` (${f.skipped} skipped)` : ""} | ${tierOf(f.file, t)} | ${f.file}${f.failed.length || f.fileError ? " (failed first)" : ""} |`);
    const reportFile = path.join(reportDir, `${tier}-${stamp}.md`);
    fs.writeFileSync(reportFile, L.join("\n") + "\n");
    fs.writeFileSync(path.join(reportDir, `${tier}-${stamp}.json`), JSON.stringify({ tier, ok: verdict.ok, startedAt, wallMs: wall, retryWallMs: retryWall, failures, flaky, allowListProblems: allow.problems, files }, null, 2));

    console.log(`\n[test-run] ${tier}: ${verdict.ok ? "PASSED" : "FAILED"}, ${files.length} files, ${totalTests} tests, ${fmt(wall)} (+${fmt(retryWall)} retries).`);
    for (const f of failures) console.log(`[test-run] failure: ${f.file} > ${f.test}${f.detail ? `: ${f.detail}` : ""}`);
    for (const f of flaky) console.log(`[test-run] flaky${allowedBy(allow.valid, f) ? " (allowed)" : " (NOT ALLOWED)"}: ${f.file} > ${f.test}`);
    for (const p of allow.problems) console.log(`[test-run] allow-list: ${p}`);
    console.log(`[test-run] slowest: ${files.slice(0, 5).map((f) => `${f.file} ${fmt(f.ms)}`).join(", ")}`);
    console.log(`[test-run] report: ${rel(reportFile)}`);
    return verdict.ok ? 0 : 1;
}

main().then(
    (code) => process.exit(code),
    (e) => {
        console.error(`[test-run] the runner failed: ${e?.stack ?? e}`);
        process.exit(2);
    },
);
