/**
 * The engine's page-side scripts work when the engine is loaded through tsx, as the platform (`npm start`) and the runner's task process
 * load it. tsx keeps function names: a helper declared inside a function that runs in the page becomes a `__name(...)` call, and the page
 * has no `__name`, so the script throws there. The test runner does not keep names, so a test calling the same code in-process passes.
 * Here the probe (tests/fixtures/page-scripts-probe.ts) runs in a tsx child process:
 *   - the picture cover (frames/shoot.ts) covers a password field and a picture is taken (Watch live, finding screenshots);
 *   - the element identity the exploration keys actions by (web/author.ts targetIdentity) resolves, so a repeat is found by the element.
 * Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/page-scripts-under-tsx.test.ts
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

const TSX = path.resolve("node_modules/.bin/tsx");

describe("page-side scripts loaded through tsx", () => {
    it("cover secret fields, take the picture and resolve an element's identity", () => {
        const out = execFileSync(TSX, ["tests/fixtures/page-scripts-probe.ts"], { encoding: "utf8", timeout: 120_000, env: { ...process.env } });
        const line = out.split("\n").find((l) => l.startsWith("PROBE "));
        expect(line, out).toBeDefined();
        const probe = JSON.parse(line!.slice("PROBE ".length)) as { cover: string; covered: number; picture: boolean; identity: string | null };
        expect(probe.cover).toBe("ok");
        expect(probe.covered).toBe(1);
        expect(probe.picture).toBe(true);
        expect(probe.identity).toMatch(/^button "Order" @[0-9a-f]{12}$/);
    }, 150_000);
});
