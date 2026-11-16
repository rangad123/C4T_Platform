/**
 * Existing tests (written test cases and test scripts) as a source: each becomes a line-numbered text document with a stable ref, cleaned
 * of secrets, for rule extraction. Pure: the cases and scripts are passed in (fast tier).
 */
import { describe, expect, it } from "vitest";
import { existingTestDocuments, numbered } from "../src/engine/intel/sources/existing-tests.js";
import type { TestSpec } from "../src/engine/spec/schema.js";

const CASE = {
    ref: "TC-001",
    title: "A shipped order cannot be cancelled",
    area: "Orders",
    requirement: "Orders can be cancelled until they ship",
    steps: [
        { action: "Open a shipped order", expected: "" },
        { action: "Press Cancel", expected: "The page says the order has shipped and cannot be cancelled" },
    ],
};

const SCRIPT: TestSpec = {
    testId: "WEB-007",
    title: "Sign in and add to cart",
    description: "A signed-in customer adds a product",
    kind: "web",
    category: "Cart",
    type: "functional",
    priority: "high",
    preconditions: ["An account exists"],
    steps: [
        { action: "navigate", url: "/login" },
        { action: "fill", locator: { by: "label", value: "Email" }, value: "{{email}}" },
        { action: "fill", locator: { by: "label", value: "Password" }, value: "Sup3r-Secret-pw!" },
        { action: "fill", locator: { by: "label", value: "One-time code" }, value: "492817" },
        { action: "fill", locator: { by: "label", value: "Quantity" }, value: "11" },
        { action: "fill", locator: { by: "label", value: "PIN" }, value: "8642", description: "Enter 8642 as the PIN" },
        { action: "assert", check: "text", locator: { by: "role", role: "alert", value: "" }, expected: "Quantity must be between 1 and 10" },
        { action: "request", method: "POST", path: "/api/login", body: { email: "a@b.c", password: "Sup3r-Secret-pw!" }, headers: { Authorization: "Bearer abcdef0123456789abcdef" }, auth: "none" },
    ],
    expectedResults: ["The cart shows 1 item"],
    testData: { email: "shopper@example.com", password: "Sup3r-Secret-pw!", apiToken: "tok_live_9f8e7d6c5b4a", otp: "735102" },
    tags: [],
    source: { origin: "manual" },
} as unknown as TestSpec;

describe("existing tests as documents", () => {
    it("a written test case becomes numbered lines: title, area, requirement, steps and expected results", () => {
        const { documents } = existingTestDocuments({ cases: [CASE], scripts: [] });
        expect(documents).toHaveLength(1);
        expect(documents[0]!.ref).toBe("manual-case:TC-001");
        expect(documents[0]!.lines).toEqual([
            "Test case TC-001: A shipped order cannot be cancelled",
            "Area: Orders",
            "Requirement: Orders can be cancelled until they ship",
            "Step 1: Open a shipped order",
            "Step 2: Press Cancel",
            "Expected after step 2: The page says the order has shipped and cannot be cancelled",
        ]);
        expect(numbered(documents[0]!).split("\n")[1]).toBe("2| Area: Orders");
    });

    it("a test script becomes numbered lines from its steps, checks and expected results", () => {
        const { documents } = existingTestDocuments({ cases: [], scripts: [{ key: "WEB-007", spec: SCRIPT }] });
        const lines = documents[0]!.lines;
        expect(documents[0]!.ref).toBe("test-script:WEB-007");
        expect(lines[0]).toBe("Test script WEB-007: Sign in and add to cart");
        expect(lines).toContain("Precondition: An account exists");
        expect(lines).toContain('Step 2: Enter "{{email}}" into label "Email"');
        expect(lines).toContain('Step 5: Enter "11" into label "Quantity"');
        expect(lines.some((l) => l.includes("Quantity must be between 1 and 10"))).toBe(true);
        expect(lines).toContain("Expected result: The cart shows 1 item");
    });

    it("typed secret values never appear: passwords, one-time codes, secret test data, credentials in requests", () => {
        const { documents } = existingTestDocuments({ cases: [], scripts: [{ key: "WEB-007", spec: SCRIPT }] });
        const text = numbered(documents[0]!);
        for (const secret of ["Sup3r-Secret-pw!", "492817", "tok_live_9f8e7d6c5b4a", "735102", "8642", "abcdef0123456789abcdef", "shopper@example.com"]) expect(text).not.toContain(secret);
        expect(text).toContain('into label "Password"');
    });

    it("text passes the shared redaction (emails, tokens, key=value secrets in written cases)", () => {
        const c = { ...CASE, steps: [{ action: "Sign in as owner@shop.example with password=hunter22 and token eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abc", expected: "" }] };
        const text = numbered(existingTestDocuments({ cases: [c], scripts: [] }).documents[0]!);
        expect(text).not.toContain("owner@shop.example");
        expect(text).not.toContain("hunter22");
        expect(text).not.toContain("eyJhbGciOiJIUzI1NiJ9");
    });

    it("refs and documents are the same across runs and whatever order the tests come in", () => {
        const other = { ...CASE, ref: "TC-002", title: "Another" };
        const a = existingTestDocuments({ cases: [CASE, other], scripts: [{ key: "WEB-007", spec: SCRIPT }] });
        const b = existingTestDocuments({ cases: [other, CASE], scripts: [{ key: "WEB-007", spec: SCRIPT }] });
        expect(a).toEqual(b);
        expect(a.documents.map((d) => d.ref)).toEqual(["manual-case:TC-001", "manual-case:TC-002", "test-script:WEB-007"]);
    });

    it("caps the number of documents and the length of a line, and says so", () => {
        const many = Array.from({ length: 520 }, (_, i) => ({ ...CASE, ref: `TC-${String(i).padStart(3, "0")}` }));
        const r = existingTestDocuments({ cases: many, scripts: [] });
        expect(r.documents).toHaveLength(500);
        expect(r.notes.join(" ")).toMatch(/500/);
        const long = existingTestDocuments({ cases: [{ ...CASE, title: "x".repeat(5000) }], scripts: [] });
        expect(long.documents[0]!.lines[0]!.length).toBeLessThanOrEqual(500);
    });

    it("hides secret-looking test data (pw, passcode, pin, answer) and test data that is not text, written descriptions and case text with passwords", () => {
        const spec = {
            ...SCRIPT,
            description: "Log in as admin with Winter2026! and check the orders",
            steps: [{ action: "click", locator: { by: "role", role: "button", value: "Sign in" }, description: "Log in as admin with Winter2026!" }],
            testData: { pw: "Spring2026!", user_pw: "Autumn2026?", passcode: "778899", pin: "4921", answer: "Fluffy", profile: { secret: "x" } },
        } as unknown as TestSpec;
        const c = { ...CASE, steps: [{ action: "Type Hunter2!Pass into the Password box", expected: "" }, { action: "Enter PIN 4921", expected: "The till opens" }] };
        const text = existingTestDocuments({ cases: [c], scripts: [{ key: "WEB-008", spec }] }).documents.map(numbered).join("\n");
        for (const secret of ["Winter2026!", "Spring2026!", "Autumn2026?", "778899", "4921", "Fluffy", "Hunter2!Pass", "[object Object]"]) expect(text).not.toContain(secret);
        expect(text).toContain("Test data: profile = [hidden]");
        expect(text).toContain("The till opens");
    });

    it("the project's own secrets are hidden wherever they appear", () => {
        const c = { ...CASE, title: "Sign in with the code word tangerine-sky" };
        const text = numbered(existingTestDocuments({ cases: [c], scripts: [], secrets: ["tangerine-sky"] }).documents[0]!);
        expect(text).not.toContain("tangerine-sky");
    });

    it("a 200 KB line is handled in well under a second", () => {
        const started = performance.now();
        existingTestDocuments({ cases: [{ ...CASE, title: "a.".repeat(100_000) }], scripts: [] });
        expect(performance.now() - started).toBeLessThan(1000);
    });
});

