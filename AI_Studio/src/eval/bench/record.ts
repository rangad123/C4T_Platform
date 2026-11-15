/**
 * What a benchmark result records so it can be reproduced and compared: the engine's commit (and whether src/engine had uncommitted changes),
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

/** The commit the engine ran at, and whether src/engine differs from it. "unknown" outside a git checkout. */
export function engineVersion(root = REPO_ROOT): { commit: string; dirty: boolean } {
    try {
        const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
        const status = execFileSync("git", ["status", "--porcelain", "--", "src/engine"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
        return { commit: /^[0-9a-f]{7,64}$/.test(commit) ? commit : "unknown", dirty: status.trim().length > 0 };
    } catch {
        return { commit: "unknown", dirty: true };
    }
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
