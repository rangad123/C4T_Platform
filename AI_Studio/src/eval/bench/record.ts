/**
 * What a benchmark result records so it can be reproduced and compared: the engine's commit (and whether src, examples or scripts had uncommitted changes),
 * a fingerprint of every engine prompt source, and the immutable baseline file (written once, with its sha256 beside it; a second write is
 * refused). Reads git with read-only commands only.
 */
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { REPO_ROOT } from "../../config.js";

/**
 * The engine files whose text decides what the model is asked (system prompts, tool descriptions, routing of purposes to models). A change
 * to any of them changes the prompt identifier of the result.
 */
export const PROMPT_SOURCES = [
    "src/engine/understanding/analyzer.ts",
    "src/engine/planning/planner.ts",
    "src/engine/web/author.ts",
    "src/engine/validation/repair.ts",
    "src/engine/llm/routing.ts",
    "src/engine/agent/objective.ts",
    "src/engine/authoring/plain.ts",
    "src/engine/requirements/parse.ts",
    "src/engine/mutation/strength.ts",
];

export function promptFingerprints(root = REPO_ROOT): Array<{ file: string; sha256: string }> {
    return PROMPT_SOURCES.filter((f) => fs.existsSync(path.join(root, f))).map((file) => ({ file, sha256: crypto.createHash("sha256").update(fs.readFileSync(path.join(root, file))).digest("hex") }));
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

/** What a copy without git (the VM's rsync --exclude .git) knows of the checkout it came from (writeEngineStamp). */
export const ENGINE_STAMP = "ENGINE_STAMP.json";

function gitVersion(root: string): { commit: string; dirty: boolean } {
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    // A copy inside some other repository is not that repository's commit.
    if (!git("ls-files", "--", "src").trim()) throw new Error("src is not tracked here");
    const commit = git("rev-parse", "HEAD").trim();
    // The fingerprint's folders: Phase 5 and the harness live outside src/engine (platform/findings, eval/bench).
    const status = git("status", "--porcelain", "--", "src", "examples", "scripts");
    return { commit: /^[0-9a-f]{7,64}$/.test(commit) ? commit : "unknown", dirty: status.trim().length > 0 };
}

/**
 * The commit the engine ran at, whether src, examples or scripts differ from it, and the tree fingerprint. Outside a git checkout, the
 * stamp written when the tree was copied: dirty when the checkout was, or when the copy no longer has the stamped fingerprint. Neither:
 * "unknown" and dirty.
 */
export function engineVersion(root = REPO_ROOT): { commit: string; dirty: boolean; fingerprint: string } {
    const fingerprint = treeFingerprint(root);
    try {
        return { ...gitVersion(root), fingerprint };
    } catch {
        try {
            const st = JSON.parse(fs.readFileSync(path.join(root, ENGINE_STAMP), "utf8")) as { commit?: unknown; dirty?: unknown; fingerprint?: unknown };
            if (typeof st.commit === "string" && /^[0-9a-f]{7,64}$/.test(st.commit)) return { commit: st.commit, dirty: st.dirty !== false || st.fingerprint !== fingerprint, fingerprint };
        } catch {
            /* no stamp */
        }
        return { commit: "unknown", dirty: true, fingerprint };
    }
}

/** Stamp a copy (`to`, its AI_Studio folder) with the commit and state of the checkout it was copied from (`from`). Run after the copy. */
export function writeEngineStamp(from: string, to: string): { commit: string; dirty: boolean; fingerprint: string } {
    const st = { ...gitVersion(from), fingerprint: treeFingerprint(from) };
    fs.writeFileSync(path.join(to, ENGINE_STAMP), `${JSON.stringify(st, null, 2)}\n`);
    return st;
}

export const sha256 = (text: string): string => crypto.createHash("sha256").update(text).digest("hex");

/**
 * Write the baseline once: `<dir>/baseline.json` and `<dir>/baseline.json.sha256`. Refuses when a baseline is already there (the baseline is
 * immutable; a new one needs its own folder). Returns the file and its hash.
 */
export function writeBaseline(dir: string, text: string): { file: string; sha256: string } {
    const file = path.join(dir, "baseline.json");
    if (fs.existsSync(file) || fs.existsSync(`${file}.sha256`)) throw new Error(`A baseline is already recorded in ${dir}; it is never overwritten. Use another --out folder for a new one.`);
    fs.mkdirSync(dir, { recursive: true });
    const hash = sha256(text);
    // "wx": fails if the file appeared in the meantime.
    fs.writeFileSync(file, text, { flag: "wx" });
    fs.writeFileSync(`${file}.sha256`, `${hash}  baseline.json\n`, { flag: "wx" });
    for (const f of [file, `${file}.sha256`]) fs.chmodSync(f, 0o444);
    return { file, sha256: hash };
}

/** Whether a recorded baseline still matches its hash. */
export function verifyBaseline(dir: string): boolean {
    const file = path.join(dir, "baseline.json");
    const want = fs.readFileSync(`${file}.sha256`, "utf8").trim().split(/\s+/)[0];
    return sha256(fs.readFileSync(file, "utf8")) === want;
}
