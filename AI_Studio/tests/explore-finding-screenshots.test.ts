/**
 * Queue row 173: a candidate finding carries screenshots. Where a replay of the independence check stops, a picture of the page is
 * taken the way the Explorer view takes one (frames/shoot.ts: password fields and fields holding a stored secret covered, small JPEG),
 * stored through the sink (`saveImageArtifact`), and the finding keeps only the references, at most FINDING_SCREENSHOTS_MAX (3; the
 * spec names no number). A finding without any picture still saves. A real browser on a local page (port 9877); no AI.
 * The whole objective stage with pictures: explore-objectives-run (the seeded shop's two findings). Run under the browser lock:
 *   node scripts/with-lock.mjs browser -- npx vitest run tests/explore-finding-screenshots.test.ts
 */
import http from "node:http";
import type { Browser } from "playwright";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { launchChromium } from "../src/engine/discovery/browser.js";
import { CandidateFindingSchema } from "../src/engine/explore/finding.js";
import { checkIndependence, replayOwnSteps } from "../src/engine/explore/independence.js";
import { defectFinding, FINDING_SCREENSHOTS_MAX, findingShooter } from "../src/engine/orchestrator.js";
import { ScenarioSchema, TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import type { AuthorOutcome } from "../src/engine/web/author.js";

const PORT = 9877;
const BASE = `http://127.0.0.1:${PORT}`;
const PASSWORD = "Pw-finding-4821";
const STORED = "stored-secret-77a1";
/** Where the two fields sit on the 1280 px page (absolute, so their place in the picture is known). */
const PASSWORD_BOX = { x: 40, y: 120, w: 520, h: 90 };
const NOTE_BOX = { x: 40, y: 260, w: 520, h: 90 };
const field = (id: string, label: string, type: string, b: typeof PASSWORD_BOX) =>
    `<label for="${id}" style="position:absolute;left:${b.x}px;top:${b.y - 30}px">${label}</label><input id="${id}" type="${type}" style="position:absolute;left:${b.x}px;top:${b.y}px;width:${b.w}px;height:${b.h}px;font-size:60px;color:#000;background:#fff;border:0;box-sizing:border-box">`;
const PAGE = `<!doctype html><html lang="en"><head><title>Account</title></head><body style="margin:0;background:#fff">
${field("pw", "Password", "password", PASSWORD_BOX)}${field("note", "Note", "text", NOTE_BOX)}
<p style="position:absolute;left:40px;top:400px">Total: <output aria-label="Total">$30.00</output></p></body></html>`;

const server = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE);
});
let browser: Browser;
beforeAll(async () => {
    await new Promise<void>((r) => server.listen(PORT, "127.0.0.1", r));
    browser = await launchChromium(true);
}, 30_000);
afterAll(async () => {
    await browser?.close();
    server.close();
});

const steps: Step[] = TestSpecSchema.parse({
    testId: "WEB-007",
    title: "Total",
    kind: "web",
    category: "c",
    source: { origin: "browser-agent" },
    steps: [
        { action: "navigate", url: "/" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: PASSWORD },
        { action: "fill", locator: { by: "label", value: "Note" }, value: STORED },
        { action: "assert", check: "exactText", locator: { by: "label", value: "Total" }, expected: "$25.00", source: "expected:1" },
    ],
}).steps;

/** The mean colour of a region of a JPEG and how far any pixel is from it, read in a browser page. */
async function look(jpeg: Uint8Array, r: { x: number; y: number; w: number; h: number }) {
    const page = await browser.newPage();
    try {
        return await page.evaluate(
            async ([data, b]) => {
                const img = new Image();
                img.src = `data:image/jpeg;base64,${data}`;
                await img.decode();
                const c = document.createElement("canvas");
                c.width = img.naturalWidth;
                c.height = img.naturalHeight;
                const g = c.getContext("2d")!;
                g.drawImage(img, 0, 0);
                const d = g.getImageData(Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)).data;
                const n = d.length / 4;
                const mean = [0, 0, 0];
                for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) mean[k]! += d[i + k]! / n;
                let spread = 0;
                for (let i = 0; i < d.length; i += 4) for (let k = 0; k < 3; k++) spread = Math.max(spread, Math.abs(d[i + k]! - mean[k]!));
                return { width: img.naturalWidth, mean, spread };
            },
            [Buffer.from(jpeg).toString("base64"), r] as [string, typeof r],
        );
    } finally {
        await page.close();
    }
}

/** The cover the Explorer view draws over a secret field (#475569), within JPEG noise. */
const covered = (m: { mean: number[]; spread: number }) => Math.abs(m.mean[0]! - 71) <= 25 && Math.abs(m.mean[1]! - 85) <= 25 && Math.abs(m.mean[2]! - 105) <= 25 && m.spread < 40;
const inner = (b: typeof PASSWORD_BOX, scale: number) => ({ x: (b.x + 8) * scale, y: (b.y + 8) * scale, w: (b.w - 16) * scale, h: (b.h - 16) * scale });

describe("a finding's screenshots", () => {
    it("are taken where each replay stops, stored through the sink, and referenced; secret fields are covered in them", async () => {
        const saved: Array<{ kind: string; name: string; jpeg: Uint8Array }> = [];
        const shoot = findingShooter(async (kind, name, jpeg) => (saved.push({ kind, name, jpeg }), `artifact-${saved.length}`), [STORED], "WEB-007");
        const r = await checkIndependence(browser, BASE, { steps }, { shoot });
        expect(r.independence).toBe("independent");
        expect(r.screenshots).toEqual(["artifact-1", "artifact-2"]);
        expect(saved.map((s) => [s.kind, s.name])).toEqual([
            ["screenshot", "WEB-007-finding-1.jpg"],
            ["screenshot", "WEB-007-finding-2.jpg"],
        ]);
        // The replays carry no picture of their own: the finding's replay entries stay as the contract has them.
        for (const replay of r.replays) expect(Object.keys(replay).sort()).toEqual(["failedStep", "label", "outcome", "summary"]);

        for (const s of saved) {
            expect([...s.jpeg.slice(0, 3)]).toEqual([0xff, 0xd8, 0xff]);
            const page = await look(s.jpeg, { x: 0, y: 0, w: 1, h: 1 });
            const scale = page.width / 1280;
            // The password (secret by kind) and the field holding a stored secret are both under the cover; the page around them is not.
            expect(covered(await look(s.jpeg, inner(PASSWORD_BOX, scale))), "password field covered").toBe(true);
            expect(covered(await look(s.jpeg, inner(NOTE_BOX, scale))), "field holding a stored secret covered").toBe(true);
            expect(covered(await look(s.jpeg, { x: 600 * scale, y: 120 * scale, w: 100 * scale, h: 90 * scale })), "the page beside them is not").toBe(false);
        }

        const found = defectFinding({ scenario, rules: [], outcome, capture: "captured", independence: r, stepCount: steps.length, modelVersion: null });
        expect(CandidateFindingSchema.parse(found.finding).evidence.screenshots).toEqual(["artifact-1", "artifact-2"]);
    }, 60_000);

    it("an own-steps replay (an observed-only finding, or one whose independence check kept no picture) keeps a picture of its last page, covered", async () => {
        const saved: Uint8Array[] = [];
        const shoot = findingShooter(async (_kind, _name, jpeg) => (saved.push(jpeg), `artifact-${saved.length}`), [STORED], "WEB-008");
        // Every step passes: the picture is of the page the test ended on.
        const passed = await replayOwnSteps(browser, BASE, { steps: steps.slice(0, 3) }, { shoot });
        expect(passed).toMatchObject({ outcome: "passed", screenshot: "artifact-1" });
        // It stops at the check: the picture is of where it stopped.
        expect(await replayOwnSteps(browser, BASE, { steps }, { shoot, stepTimeoutMs: 5_000 })).toMatchObject({ outcome: "failed", failedStep: 4, screenshot: "artifact-2" });
        const scale = (await look(saved[0]!, { x: 0, y: 0, w: 1, h: 1 })).width / 1280;
        expect(covered(await look(saved[0]!, inner(PASSWORD_BOX, scale))), "password field covered").toBe(true);
        expect(covered(await look(saved[0]!, inner(NOTE_BOX, scale))), "field holding a stored secret covered").toBe(true);
        // Without a shooter it takes none.
        expect(await replayOwnSteps(browser, BASE, { steps: steps.slice(0, 3) })).not.toHaveProperty("screenshot");
        const found = defectFinding({ scenario, rules: [], outcome: { ...outcome, capture: "observed_only" }, capture: "observed_only", independence: { independence: "not_run", replays: [], screenshots: [passed.screenshot!] }, stepCount: 3, modelVersion: null });
        expect(CandidateFindingSchema.parse(found.finding).evidence.screenshots).toEqual(["artifact-1"]);
    }, 60_000);

    it("a picture that cannot be taken or stored is left out, and the check stands", async () => {
        // Six replays whose checked Total fails by design, each waiting its step time: at the 10 s default (row 236) they pass 60 s.
        const stepTimeoutMs = 5_000;
        const failing = await checkIndependence(browser, BASE, { steps }, { stepTimeoutMs, shoot: async () => Promise.reject(new Error("the store is away")) });
        expect(failing).toMatchObject({ independence: "independent", screenshots: [] });
        const none = await checkIndependence(browser, BASE, { steps }, { stepTimeoutMs, shoot: async () => undefined });
        expect(none).toMatchObject({ independence: "independent", screenshots: [] });
        // Without a sink that stores pictures there is nothing to list.
        expect(await checkIndependence(browser, BASE, { steps }, { stepTimeoutMs })).not.toHaveProperty("screenshots");
    }, 60_000);
});

const scenario = ScenarioSchema.parse({ scenarioId: "S-T", title: "Total", description: "d", category: "c", startPath: "/", expectedResults: ["The total is $25.00 (source: R-T)"] });
const outcome: Extract<AuthorOutcome, { status: "defect" }> = { status: "defect", steps: [], testData: {}, explanation: "The total shows $30.00", capture: "captured", capturedCheck: { source: "expected:1", observed: "$30.00" } };

describe("the finding keeps references only", () => {
    it(`keeps at most ${FINDING_SCREENSHOTS_MAX} references`, () => {
        const independence = { independence: "independent" as const, replays: [], screenshots: ["a", "b", "c", "d", "e"] };
        const found = defectFinding({ scenario, rules: [], requirementIds: [], outcome, capture: "captured", independence, stepCount: 4, modelVersion: null });
        expect(FINDING_SCREENSHOTS_MAX).toBe(3);
        expect(found.finding!.evidence.screenshots).toEqual(["a", "b", "c"]);
    });

    it("a finding without any screenshot still saves", () => {
        for (const independence of [{ independence: "not_run" as const, replays: [] }, { independence: "independent" as const, replays: [], screenshots: [] }]) {
            const found = defectFinding({ scenario, rules: [], outcome, capture: "captured", independence, stepCount: 4, modelVersion: null });
            expect(found.problem).toBeUndefined();
            expect(CandidateFindingSchema.parse(found.finding).evidence.screenshots).toEqual([]);
        }
    });
});
