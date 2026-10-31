/**
 * A promise nothing waits for, or one used as if it were its value (scripts/floating-promises.ts). While the stores go async a missed
 * `await` often still compiles: `if (store.allowed(id))` tests a promise, which is always true, so a check silently passes. The list
 * below holds the deliberate exceptions and must not grow without a reason beside each entry.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { findFloatingPromises, keyOf } from "../scripts/floating-promises.js";

const DELIBERATE = new Set([
    // Comparing two promise objects by identity: "is this still the operation in progress?".
    "src/platform/agent-record.ts|compare|this.snapshotWait?.promise === promise",
    "src/platform/job-write-queue.ts|compare|this.tail === settled",
    "src/platform/settings-cache.ts|compare|this.inFlight === tracked",
]);

describe("no promise is left floating in src/", () => {
    it("finds nothing beyond the deliberate list, and the list has nothing stale", { timeout: 180_000 }, () => {
        const found = findFloatingPromises();
        const keys = new Set(found.map(keyOf));
        expect(found.filter((f) => !DELIBERATE.has(keyOf(f))).map((f) => `${f.file}:${f.line} ${f.kind} ${f.text}`)).toEqual([]);
        expect([...DELIBERATE].filter((k) => !keys.has(k))).toEqual([]);
    });

    it("catches each kind of mistake, and leaves the right forms alone", { timeout: 60_000 }, () => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-floating-"));
        try {
            fs.mkdirSync(path.join(dir, "src"));
            fs.writeFileSync(path.join(dir, "tsconfig.json"), JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, types: [] }, include: ["src"] }));
            fs.writeFileSync(
                path.join(dir, "src", "probe.ts"),
                `declare function allowed(id: string): Promise<boolean>;
declare function save(id: string): Promise<void>;
declare const pending: Promise<void> | null;
declare function log(value: unknown): void;
export async function bad(id: string) {
    if (allowed(id)) return 1;
    const v = !allowed(id);
    const ok = allowed(id);
    if (ok) return 2;
    save(id);
    const t = allowed(id) ? 1 : 2;
    const c = allowed(id) === allowed(id);
    const merged = { ...allowed(id) };
    log(allowed(id));
    return [v, t, c, merged];
}
export async function good(id: string) {
    if (await allowed(id)) return 1;
    await save(id);
    void save(id);
    save(id).catch(() => undefined);
    if (pending) await pending;
    const all = await Promise.all([allowed(id), allowed(id)]);
    return all;
}
`,
            );
            const found = findFloatingPromises(dir);
            const lines = found.map((f) => f.line);
            expect(found.map((f) => f.kind)).toEqual(["condition", "condition", "condition", "statement", "condition", "compare", "spread", "argument"]);
            // Nothing from good(), which starts at line 17.
            expect(Math.max(...lines)).toBeLessThan(17);
        } finally {
            fs.rmSync(dir, { recursive: true, force: true });
        }
    });
});
