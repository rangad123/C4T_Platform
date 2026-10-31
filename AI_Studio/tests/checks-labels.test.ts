/**
 * Plain-language wording of the health and security checks (no browser, no server): type label, step
 * sentences, and how a finding's reason reads once the UI has cleaned it.
 */
import { describe, expect, it } from "vitest";
import { describeStep } from "../src/engine/spec/schema.js";
import { cleanReason, stepSentence, typeLabel } from "../web/src/lib/labels.js";

describe("labels for the new checks", () => {
    it("names the new test type", () => {
        expect(typeLabel("health")).toBe("Health check");
        expect(typeLabel("security")).toBe("Security");
    });

    it("words every health assert and security response check without jargon", () => {
        const health = ["noConsoleErrors", "noFailedRequests", "noBrokenLinks", "noMixedContent", "pageBasics"].map((check) => stepSentence({ action: "assert", check }));
        expect(health).toEqual([
            "Check that the page reports no script errors",
            "Check that no request to your site fails",
            "Check that the page has no broken links",
            "Check that no insecure (http://) content is loaded on the secure page",
            "Check that the page has a title, a language, a viewport setting and one main heading",
        ]);
        const security = ["securityHeaders", "cookieFlags", "corsPolicy", "noExposedFiles", "noInfoDisclosure", "tlsCertificate"].map((check) => stepSentence({ action: "assertResponse", check, description: "internal wording" }));
        expect(security).toEqual([
            "Check that the browser security headers are set",
            "Check that session cookies are protected",
            "Check that other websites can’t use your visitors’ logins across origins",
            "Check that none of these sensitive files can be downloaded",
            "Check that the server doesn’t reveal software versions or list folders",
            "Check that the HTTPS certificate is valid and not about to expire",
        ]);
        for (const s of [...health, ...security]) expect(s).not.toMatch(/noConsole|assertResponse|[a-z][A-Z][a-z]+[A-Z]|\[(high|medium|low)\]/);
        // other response checks keep their curated description
        expect(stepSentence({ action: "assertResponse", check: "status", expected: 200, description: "Request succeeds" })).toBe("Request succeeds");
    });

    it("the engine's own step wording agrees with the checks it describes", () => {
        expect(describeStep({ action: "assert", check: "noMixedContent", description: "" })).toMatch(/insecure/);
        expect(describeStep({ action: "assertResponse", check: "tlsCertificate", description: "" })).toMatch(/certificate/);
    });
});

describe("cleanReason on findings", () => {
    it("turns a health finding into bullets without severity tags", () => {
        const reason = [
            "Page health check failed: 2 requests to this site failed",
            "- [high] GET /api/boom returned HTTP 500",
            "- [medium] GET /api/missing returned HTTP 404",
            "How to fix: Check the listed addresses.",
        ].join("\n");
        expect(cleanReason(reason)).toBe("Page health check: 2 requests to this site failed • GET /api/boom returned HTTP 500 • GET /api/missing returned HTTP 404. How to fix: Check the listed addresses.");
        // several checks in one finding read as separate sentences
        const several = "Page health check failed: 1 JavaScript error was reported on this page\n- [medium] console.error: x\n2 links on this page are broken (checked 5)\n- [medium] /a returned HTTP 404\nHow to fix: Fix them.";
        expect(cleanReason(several)).toBe("Page health check: 1 JavaScript error was reported on this page • console.error: x. 2 links on this page are broken (checked 5) • /a returned HTTP 404. How to fix: Fix them.");
        expect(cleanReason(reason)).not.toMatch(/\[(high|medium|low)\]/);
    });

    it("turns a security finding into bullets that already say how to fix each problem", () => {
        const reason = "Security check failed: 1 sensitive file is publicly readable\n- [critical] /.env can be downloaded by anyone (it holds secret settings). Remove it from the web server's public folder or block it in the server settings.";
        expect(cleanReason(reason)).toBe("Security check: 1 sensitive file is publicly readable • /.env can be downloaded by anyone (it holds secret settings). Remove it from the web server's public folder or block it in the server settings.");
    });

    it("leaves other reasons (accessibility, API) as they were", () => {
        expect(cleanReason("Accessibility audit failed: 1 WCAG rule violated\n- image-alt [critical]: Images must have alt text (1 node: img)")).toBe(
            "Accessibility audit failed: 1 WCAG rule violated - image-alt [critical]: Images must have alt text (1 node: img)",
        );
        expect(cleanReason("Server error: GET /x returned 500")).toBe("Server error: GET /x returned 500");
    });
});
