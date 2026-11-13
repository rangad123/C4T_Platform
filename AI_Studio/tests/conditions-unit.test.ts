/**
 * Time and conditions without a browser: what the clock and condition steps render to, the plain refusals, the pinned date, the condition
 * variants and their level knob, the saved sign-in's IndexedDB and sessionStorage, and the socket faults offered.
 */
import { describe, expect, it } from "vitest";
import { LEVEL_SETTINGS } from "../src/engine/levels.js";
import { playwrightState, parseStorageState, secretValuesOf, sessionStorageText } from "../src/engine/auth/storage-state.js";
import { SESSION_SETUP_FILE, sessionSetupSource, withSessionLine } from "../src/engine/auth/run-session.js";
import { renderWithAdapter } from "../src/engine/frameworks/index.js";
import { describeStep, TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { configFor } from "../src/engine/validation/runner.js";
import { EXTRA_VARIANT_IDS, isKeyTest, variantFits, VARIANTS } from "../src/engine/validation/variants.js";
import { clockTime, pinToday, planCondition, renderClock, renderCondition } from "../src/engine/web/conditions.js";
import { generateSignedInVisualSpecs, generateVisualSpecs } from "../src/engine/visual/baseline.js";
import { generateVisionSpecs } from "../src/engine/vision/specs.js";
import { socketFaults } from "../src/engine/web/socket-faults.js";

const cond = (set: string, value?: string) => ({ action: "condition", set, ...(value !== undefined ? { value } : {}) }) as Extract<Step, { action: "condition" }>;

describe("clock and condition steps", () => {
    it("render to page.clock and the context calls", () => {
        expect(renderClock({ action: "clock", op: "install", description: "" })).toBe("await page.clock.install();");
        expect(renderClock({ action: "clock", op: "fastForward", minutes: 30, description: "" })).toBe("await page.clock.fastForward(1800000);");
        expect(renderClock({ action: "clock", op: "pauseAt", time: "2025-01-15", description: "" })).toBe('await page.clock.pauseAt(new Date("2025-01-15T12:00:00.000Z"));');
        expect(renderCondition(cond("offline"))).toBe("await page.context().setOffline(true);");
        expect(renderCondition(cond("colorScheme", "dark"))).toBe('await page.emulateMedia({ colorScheme: "dark" });');
        expect(renderCondition(cond("viewport", "390x844"))).toBe("await page.setViewportSize({ width: 390, height: 844 });");
        expect(renderCondition(cond("denyPermissions"))).toBe("await page.context().clearPermissions();");
        expect(renderCondition(cond("geolocation", "52.52,13.4"))).toContain("setGeolocation({ latitude: 52.52, longitude: 13.4 })");
    });

    it("refuse values that do not fit, in plain words", () => {
        expect(() => clockTime("tomorrow", "Stopping the clock")).toThrow(/needs a date like 2025-01-15/);
        expect(() => renderClock({ action: "clock", op: "fastForward", description: "" })).toThrow(/number of minutes/);
        expect(() => planCondition(cond("colorScheme", "purple"))).toThrow(/light, dark/);
        expect(() => planCondition(cond("grantPermissions", "telepathy"))).toThrow(/not one: telepathy/);
        expect(() => planCondition(cond("geolocation", "north"))).toThrow(/latitude,longitude/);
    });

    it("read in plain words, and a phone test refuses them", () => {
        expect(describeStep({ action: "clock", op: "fastForward", minutes: 5, description: "" })).toBe("Move the clock 5 minute(s) ahead");
        expect(describeStep({ ...cond("offline"), description: "" })).toMatch(/offline/);
        const phone = TestSpecSchema.parse({ testId: "MOB-001", title: "Phone", kind: "mobile", steps: [{ action: "clock", op: "install" }] });
        expect(() => renderWithAdapter(phone, "taqwright", { baseUrl: "http://x" })).toThrow(/web pages only/);
    });

    it("a pinned date is set before the first page opens; visual checks are pinned to the day they were made", () => {
        const t = TestSpecSchema.parse({ testId: "WEB-001", title: "Pinned", kind: "web", pinnedTime: "2025-01-15T08:00:00Z", steps: [{ action: "navigate", url: "/" }] });
        const c = renderWithAdapter(t, "playwright", { baseUrl: "http://x" }).content;
        expect(c.indexOf("page.clock.setFixedTime")).toBeLessThan(c.indexOf("page.goto"));
        expect(pinToday(new Date("2026-03-04T23:59:00Z"))).toBe("2026-03-04T12:00:00.000Z");
        // Signed-out visual and vision checks are pinned; signed-in ones keep the real date (and a saved-session run drops a pin).
        const pm = (path: string, title: string, type: string, depth = 1) => ({ url: "http://x" + path, path, title, type, depth, status: 200, headings: [title], forms: [], components: [], links: [], aria: "", text: "", apiCalls: [], revealed: [], consoleErrors: [] });
        const model = { url: "http://x/", origin: "http://x", siteType: "unknown", purpose: "", features: [], pages: [pm("/", "Acme", "home", 0), pm("/pricing", "Pricing", "content")], navigation: [], apis: [], authentication: { required: false, mechanisms: [], loggedIn: false }, journeys: [], externalDependencies: [], documentedTestCases: [], stats: { pagesVisited: 2, pagesSkipped: 0, apisFound: 0, durationMs: 0 } } as never;
        expect(generateVisualSpecs(model, { maxPages: 1 })[0]?.pinnedTime).toBe(pinToday());
        expect(generateVisionSpecs(model, { maxPages: 1 } as never)[0]?.pinnedTime).toBe(pinToday());
        const form = { path: "/login", userCss: "#u", passwordCss: "#p" };
        const signedIn = generateSignedInVisualSpecs({ form, accounts: [{ account: { role: null, who: "the default account", needsCode: false }, pages: [{ path: "/app", name: "App", priority: "high" }] }], gated: new Set() });
        expect(signedIn[0]!.pinnedTime).toBeUndefined();
        expect(withSessionLine(c)).not.toContain("setFixedTime");
    });
});

describe("conditions as variants", () => {
    it("are offered with the browsers, carry their options into the config, and Deep and Everything add dark mode and another locale", () => {
        for (const v of ["dark", "locale", "high-contrast", "reduced-motion", "no-js"]) expect(EXTRA_VARIANT_IDS).toContain(v);
        const cfg = configFor([{ name: "dark", device: "Desktop Chrome", use: VARIANTS.dark.use! }]);
        expect(cfg).toContain('...{"colorScheme":"dark"}');
        expect(LEVEL_SETTINGS.thorough.conditionVariants).toEqual([]);
        expect(LEVEL_SETTINGS.deep.conditionVariants).toEqual(["dark", "locale"]);
        expect(LEVEL_SETTINGS.everything.conditionVariants).toEqual(["dark", "locale"]);
        expect(isKeyTest(TestSpecSchema.parse({ testId: "WEB-001", title: "Key", kind: "web", priority: "high", steps: [{ action: "navigate", url: "/" }] }))).toBe(true);
    });

    it("JavaScript off takes only tests that open pages and read them", () => {
        const read = TestSpecSchema.parse({ testId: "WEB-001", title: "Read", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "assert", check: "title", expected: "Home" }] });
        const act = TestSpecSchema.parse({ testId: "WEB-002", title: "Act", kind: "web", steps: [{ action: "navigate", url: "/" }, { action: "click", locator: { by: "text", value: "Go" } }] });
        expect(variantFits("no-js", read).fits).toBe(true);
        expect(variantFits("no-js", act).fits).toBe(false);
        expect(variantFits("dark", act).fits).toBe(true);
    });
});

describe("a saved sign-in beyond cookies", () => {
    const state = parseStorageState({
        cookies: [],
        origins: [{ origin: "https://app.example", localStorage: [], indexedDB: [{ name: "firebaseLocalStorageDb", version: 1, stores: [{ name: "store", records: [{ key: "k", value: { token: "eyJ-secret-token" } }] }] }], sessionStorage: [{ name: "tab", value: "tab-secret-1" }] }],
        checkUrl: "https://app.example/home",
    });
    it("keeps IndexedDB and sessionStorage, masks their values, and hands Playwright only what it knows", () => {
        expect(secretValuesOf(state)).toEqual(expect.arrayContaining(["eyJ-secret-token", "tab-secret-1"]));
        const pw = playwrightState(state);
        expect(pw.origins[0]).not.toHaveProperty("sessionStorage");
        expect(pw).not.toHaveProperty("checkUrl");
        expect(pw.origins[0]!.indexedDB).toHaveLength(1);
        expect(JSON.parse(sessionStorageText(state))).toEqual([{ origin: "https://app.example", items: [{ name: "tab", value: "tab-secret-1" }] }]);
    });
    it("refuses a sessionStorage too large to hand to a run", () => {
        expect(() => parseStorageState({ cookies: [], origins: [{ origin: "https://a.example", localStorage: [], sessionStorage: [{ name: "big", value: "x".repeat(30_000) }] }] })).toThrow(/storage state/);
    });
    it("adds the restore line only when there is sessionStorage, and the renewal never types the password on another site", () => {
        const s = 'import { test, expect } from "@playwright/test";\ntest("x", async () => {});\n';
        expect(withSessionLine(s)).not.toContain("AITP_SESSION_STORAGE");
        expect(withSessionLine(s, true)).toContain("AITP_SESSION_STORAGE");
        expect(SESSION_SETUP_FILE).toMatch(/\.ts$/);
        expect(sessionSetupSource("https://app.example/home")).toContain("is on another site, so the run did not sign in again");
    });
});

describe("socket faults", () => {
    it("are offered only when the app was seen opening a WebSocket; offline always", () => {
        expect(socketFaults(false).map((f) => f.kind)).toEqual(["offline"]);
        expect(socketFaults(true).map((f) => f.kind)).toEqual(["socket-drop", "socket-error", "offline"]);
    });
});
