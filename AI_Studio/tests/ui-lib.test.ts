/** The UI's plain-language layer: URL entry, status wording, errors, steps, time. */
import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { codeSpans } from "../web/src/components/code-spans.js";
import { duration, plural, relativeTime } from "../web/src/lib/format.js";
import { cleanReason, friendlyError, friendlyJobErrors, jobLabel, phaseText, progressPercent, stepSentence, VALIDATION } from "../web/src/lib/labels.js";
import { normalizeUrl } from "../web/src/lib/url.js";

const counters = { pagesDiscovered: 6, apisDiscovered: 4, journeysIdentified: 8, scenariosPlanned: 10, testsGenerated: 16, testsValidated: 14, testsFailedValidation: 0, testsNeedingReview: 2, scenariosSkipped: 0 };

describe("normalizeUrl", () => {
    it("adds https to public hosts and http to local ones", () => {
        expect(normalizeUrl("example.com").url).toBe("https://example.com/");
        expect(normalizeUrl("localhost:5057").url).toBe("http://localhost:5057/");
        expect(normalizeUrl("192.168.1.20:3000/app").url).toBe("http://192.168.1.20:3000/app");
        expect(normalizeUrl("https://shop.test/x").url).toBe("https://shop.test/x");
        expect(normalizeUrl("  http://stage.example.com  ").url).toBe("http://stage.example.com/");
    });
    it("explains what is wrong in plain words", () => {
        expect(normalizeUrl("").error).toMatch(/Enter the address/);
        expect(normalizeUrl("ftp://files.example.com").error).toMatch(/http:\/\/ or https:\/\//);
        expect(normalizeUrl("notaurl").error).toMatch(/complete address/);
    });
});

describe("status language", () => {
    it("never shows internal state names", () => {
        const labels = Object.values(VALIDATION).map((v) => v.label);
        expect(labels).toEqual(["Passing", "Needs a look", "Failing", "Running…", "Not run yet"]);
        for (const status of ["QUEUED", "DISCOVERING", "ANALYZING", "PLANNING", "GENERATING", "VALIDATING", "COMPLETED", "PARTIALLY_COMPLETED", "FAILED"] as const) {
            expect(jobLabel({ status, error: null }).label).not.toMatch(/[A-Z]{4,}_|^[A-Z_]+$/);
        }
        expect(jobLabel({ status: "FAILED", error: "Cancelled" }).label).toBe("Stopped");
    });
    it("describes each phase by what it found", () => {
        expect(phaseText("discovery", "done", counters)).toEqual({ title: "Application explored", detail: "Found 6 pages and 4 API endpoints" });
        expect(phaseText("validation", "done", counters).detail).toBe("14 of 16 passed");
        expect(phaseText("generation", "running", { ...counters, testsGenerated: 3 }).title).toBe("Creating test scripts…");
    });
    it("progress advances with phases and is 100 when finished", () => {
        const progress = { discovery: "done", understanding: "running", planning: "pending", generation: "pending", validation: "pending" } as const;
        expect(progressPercent({ status: "ANALYZING", progress })).toBe(30);
        expect(progressPercent({ status: "COMPLETED", progress })).toBe(100);
    });
});

describe("errors", () => {
    it("translate raw engine errors into what / why / what to do", () => {
        expect(friendlyError('No credentials for LLM provider "anthropic". Set ANTHROPIC_API_KEY').fix?.href).toBe("#/settings#ai-keys");
        expect(friendlyError("Authoring failed: Cannot connect to API: getaddrinfo ENOTFOUND openrouter.ai").title).toBe("We couldn’t reach the AI service");
        expect(friendlyError("Discovery found no loadable pages at https://x.test").title).toBe("We couldn’t access this application");
        expect(friendlyError("Cancelled").title).toBe("This run was stopped");
        expect(friendlyError("").title).toBe("Something went wrong");
    });
    it("de-duplicates the many errors one job can carry", () => {
        const e = friendlyJobErrors("Authoring A: Cannot connect to API: ENOTFOUND openrouter.ai | Authoring B: Cannot connect to API: ENOTFOUND openrouter.ai");
        expect(e).toHaveLength(1);
    });
    it("strips the engine's boilerplate from findings", () => {
        expect(cleanReason("The application did not behave as expected: cart count is wrong")).toBe("cart count is wrong");
    });
});

describe("steps in plain language", () => {
    const l = (role: string, value: string) => ({ by: "role", role, value });
    it("reads like instructions", () => {
        expect(stepSentence({ action: "navigate", url: "/login" })).toBe("Open /login");
        expect(stepSentence({ action: "click", locator: l("button", "Log in") })).toBe("Click the “Log in” button");
        expect(stepSentence({ action: "fill", locator: { by: "label", value: "Email" }, value: "{{credentials.username}}" })).toBe("Type “your test username” into the “Email” field");
        expect(stepSentence({ action: "assert", check: "url", expected: "/account" })).toBe("Check that the address contains “/account”");
        expect(stepSentence({ action: "assert", check: "visible", locator: l("heading", "Welcome") })).toBe("Check that the “Welcome” heading is visible");
        expect(stepSentence({ action: "assert", check: "screenshot" })).toBe("Check that the page looks the same as its approved screenshot");
        expect(stepSentence({ action: "assert", check: "a11y", expected: "serious" })).toMatch(/accessibility problems/);
    });
    it("keeps curated API step descriptions", () => {
        expect(stepSentence({ action: "request", method: "GET", path: "/x", description: "Send a valid GET request" })).toBe("Send a valid GET request");
    });
});

describe("format", () => {
    const now = Date.parse("2026-10-05T12:00:00Z");
    it("relative time", () => {
        expect(relativeTime("2026-10-05T11:59:50Z", now)).toBe("just now");
        expect(relativeTime("2026-10-05T11:55:00Z", now)).toBe("5 min ago");
        expect(relativeTime("2026-10-05T09:00:00Z", now)).toBe("3 hours ago");
        expect(relativeTime("2026-10-04T10:00:00Z", now)).toBe("yesterday");
        expect(relativeTime(null)).toBe("—");
    });
    it("duration and plurals", () => {
        expect(duration(450)).toBe("450 ms");
        expect(duration(3200)).toBe("3.2 s");
        expect(duration(125_000)).toBe("2 min 5 s");
        expect(duration(59_600)).toBe("1 min 0 s");
        expect(duration(119_700)).toBe("2 min 0 s");
        expect(duration(9_960)).toBe("10 s");
        expect(plural(1, "test")).toBe("1 test");
        expect(plural(2, "test")).toBe("2 tests");
    });
});

describe("cleanReason", () => {
    it("translates framework and repair-loop jargon", () => {
        expect(cleanReason("2. Request succeeds — Error: expect(received).toBe(expected) // Object.is equality (automatic repair failed: Provider returned error)")).toBe(
            "2. Request succeeds — the result didn’t match what the test expected. An automatic fix was tried but didn’t work.",
        );
        expect(cleanReason("Server error: GET /x returned 500 (automatic repair skipped: no LLM configured)")).toBe("Server error: GET /x returned 500. Automatic fixing isn’t available because there is no usable AI key.");
        expect(cleanReason("3. Click button — locator.click: Timeout 10000ms exceeded.")).toBe("3. Click button — the element couldn’t be found in time");
    });
});

describe("cleanReason (assertion phrasing)", () => {
    it("does not leave a dangling 'failed'", () => {
        expect(cleanReason("Error: expect(page).toHaveScreenshot(expected) failed")).toBe("the result didn’t match what the test expected");
    });
});

describe("codeSpans (CodeViewer colours)", () => {
    it("colours code with the editor's parser and keeps it as escaped text", () => {
        const code = 'const a = "<img src=x onerror=alert(1)>"; // note\nawait page.goto("/");\n';
        const html = renderToStaticMarkup(createElement("code", null, codeSpans(code, "typescript")));
        expect(html).toContain('<span class="tok-keyword">const</span>');
        expect(html).toContain('class="tok-comment">// note</span>');
        expect(html).toContain("&lt;img");
        expect(html).not.toContain("<img");
        const text = html.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/&amp;/g, "&");
        expect(text).toBe(code);
        const json = renderToStaticMarkup(createElement("code", null, codeSpans('{"a": 1, "b": true}', "json")));
        expect(json).toContain('<span class="tok-number">1</span>');
        expect(json).toContain('<span class="tok-bool">true</span>');
    });
});
