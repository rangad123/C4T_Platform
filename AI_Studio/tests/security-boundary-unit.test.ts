/**
 * The security assessment module (src/security) stays separate from functional testing: nothing outside it imports it except the
 * three wiring points below, and the module itself never imports the functional test runner or job runner.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "src");
/**
 * The only places that may name src/security: the migration list, the route registration, the standalone worker, project backups (and the
 * storage route that offers leaving security data out of one), and (round 52) the runner's explore child, which runs an assessment's steps.
 */
const WIRING = ["src/platform/db.ts", "src/platform/routes/index.ts", "src/worker-main.ts", "src/platform/backup.ts", "src/platform/routes/retention.ts", "src/agent/explore-child.ts"];

function files(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name)) : d.name.endsWith(".ts") ? [path.join(dir, d.name)] : []));
}
const rel = (f: string) => path.relative(ROOT, f).split(path.sep).join("/");
const importsOf = (f: string) => [...fs.readFileSync(f, "utf8").matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]!);
const resolves = (from: string, spec: string) => (spec.startsWith(".") ? rel(path.resolve(path.dirname(from), spec)) : spec);

describe("the security module's boundaries", () => {
    it("nothing outside src/security imports it except the wiring points", () => {
        const offenders: string[] = [];
        for (const f of files(SRC)) {
            const r = rel(f);
            if (r.startsWith("src/security/") || WIRING.includes(r)) continue;
            for (const spec of importsOf(f)) if (resolves(f, spec).startsWith("src/security/")) offenders.push(`${r} imports ${spec}`);
        }
        expect(offenders).toEqual([]);
    });

    it("the module does not use the functional test runner, job runner or worker", () => {
        const forbidden = ["src/platform/job-runner", "src/platform/worker", "src/engine/validation/runner", "src/engine/validation/validator", "src/engine/orchestrator"];
        const offenders: string[] = [];
        for (const f of files(path.join(SRC, "security"))) {
            for (const spec of importsOf(f)) {
                const target = resolves(f, spec).replace(/\.js$/, "");
                if (forbidden.includes(target)) offenders.push(`${rel(f)} imports ${spec}`);
            }
        }
        expect(offenders).toEqual([]);
    });
});
