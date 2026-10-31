/**
 * Round 21 (FX-S) without a browser: a saved sign-in that stops working during an assessment (the coverage sentences, the plain
 * "still signed in?" check before the read-only checks, the guard sending nothing signed in afterwards) and the words a restore uses for
 * security data. One local fixture app WE start (ports 7212/7213) whose session ends on the server when the test says so.
 *
 *   node scripts/with-lock.mjs browser -- node node_modules/vitest/vitest.mjs run tests/security-fx-unit.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { StorageState } from "../src/engine/auth/storage-state.js";
import { checkSignInPlain, emptyDiscovery } from "../src/security/assessment/discover.js";
import { guardFor } from "../src/security/assessment/guard.js";
import { notInspected, signInEndedSentence } from "../src/security/assessment/runner.js";
import { securityRestoreWords } from "../src/security/backup.js";
import type { SecurityApplication } from "../src/security/contract.js";
import { securitySettings } from "../src/security/settings.js";
import { FIXTURE_SESSION_COOKIE, FIXTURE_SESSION_VALUE, startSecurityFixture, type SecurityFixture } from "./fixtures/security-fixture-app.js";

let fixture: SecurityFixture;
beforeAll(async () => {
    fixture = await startSecurityFixture(7212, 7213);
});
afterAll(async () => {
    await fixture?.close();
});

const LABEL = "the project's own account";
const lim = { maxPages: 30, maxDepth: 3 };
const withCookie = (r: SecurityFixture["requests"][number]) => String(r.headers.cookie ?? "").includes(`${FIXTURE_SESSION_COOKIE}=${FIXTURE_SESSION_VALUE}`);

describe("a saved sign-in that stops working: the coverage sentence", () => {
    it("found while looking at the pages: from which point signed-in pages were not inspected", () => {
        expect(signInEndedSentence(LABEL, { when: "discovery", afterPages: 14, lastOkAfterPages: 10, url: "/account", reason: "answered HTTP 401" })).toBe(
            "The saved sign-in for the project's own account stopped working after 14 pages (the signed-in page /account answered HTTP 401; it last worked after 10 pages); signed-in pages after that were not inspected. Save the sign-in again in Settings. It was not signed in again: no password was typed and no form was submitted.",
        );
        // Without a signed-in page it is the browser's cookies that tell.
        expect(signInEndedSentence(LABEL, { when: "discovery", afterPages: 6, lastOkAfterPages: 4, url: null, reason: "its cookies were removed or ran out" })).toContain(
            "stopped working after 6 pages (its cookies were removed or ran out; it last worked after 4 pages); signed-in pages after that were not inspected.",
        );
    });

    it("found right before the read-only checks: the checks were made signed out, and which pages may have been seen signed out", () => {
        expect(signInEndedSentence(LABEL, { when: "before-checks", afterPages: 8, lastOkAfterPages: 2, url: "/account", reason: "moved to the sign-in address /login" })).toBe(
            "The saved sign-in for the project's own account no longer worked when the read-only checks started (the signed-in page /account moved to the sign-in address /login; it last worked after 2 pages); the read-only checks were made signed out. Pages after the first 2 pages may have been looked at signed out. Save the sign-in again in Settings. It was not signed in again: no password was typed and no form was submitted.",
        );
        // A retest looks at no pages first.
        const retest = signInEndedSentence(LABEL, { when: "before-checks", afterPages: 0, lastOkAfterPages: 0, url: "/account", reason: "answered HTTP 403" });
        expect(retest).toContain("no longer worked when the read-only checks started (the signed-in page /account answered HTTP 403); the read-only checks were made signed out. Save the sign-in again in Settings.");
        expect(retest).not.toMatch(/looked at signed out/);
        expect(signInEndedSentence(LABEL, { when: "before-checks", afterPages: 5, lastOkAfterPages: 0, url: null, reason: "its cookies ran out" })).toContain("Some of the 5 pages may have been looked at signed out.");
    });

    it("takes the place of the 'signed in' line in the coverage list; a sign-in that failed its first look keeps that sentence", () => {
        const d = emptyDiscovery("http://x.test/");
        d.signedInCheck = { url: "/account", ok: true, reason: "showed a signed-in page" };
        d.signInEnded = { when: "discovery", afterPages: 6, lastOkAfterPages: 4, url: "/account", reason: "answered HTTP 401" };
        const list = notInspected(d, [], [], lim, { signIn: { label: LABEL, used: true } });
        expect(list[0]).toMatch(/^The saved sign-in for the project's own account stopped working after 6 pages/);
        expect(list.join("\n")).not.toMatch(/^Signed in with the saved sign-in/m);
        d.signedInCheck = { url: "/account", ok: false, reason: "answered HTTP 401" };
        expect(notInspected(d, [], [], lim, { signIn: { label: LABEL, used: true } })[0]).toMatch(/^Signed-in pages may not have been inspected: with the saved sign-in/);
        // Unchanged when it kept working.
        const fine = emptyDiscovery("http://x.test/");
        expect(notInspected(fine, [], [], lim, { signIn: { label: LABEL, used: true } })[0]).toMatch(/^Signed in with the saved sign-in for the project's own account/);
    });
});

describe("the plain check before the read-only checks, and nothing signed in afterwards", () => {
    const app = (): SecurityApplication => ({
        id: "a1",
        projectId: "p1",
        name: "Shop",
        targetUrl: `${fixture.origin}/`,
        environment: "development",
        scope: [],
        excludedPaths: [],
        maxRequestsPerSecond: 10,
        apiSpecUrl: null,
        notes: null,
        createdAt: "",
        updatedAt: "",
    });
    const state = (): StorageState => ({
        cookies: [{ name: FIXTURE_SESSION_COOKIE, value: FIXTURE_SESSION_VALUE, domain: "127.0.0.1", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" }],
        origins: [],
    });

    it("judges the signed-in page with the saved cookies; after the session ended on the server it says why; then no cookie is sent", async () => {
        fixture.expireSessionAfter(null);
        const signal = new AbortController().signal;
        const guard = guardFor(app(), securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" }), signal, {}, { state: state(), refuseSignOut: true });
        const from = fixture.requests.length;
        expect(await checkSignInPlain(guard, `${fixture.origin}/account`, signal)).toEqual({ ok: true, reason: "showed a signed-in page" });
        expect(fixture.requests.slice(from).every(withCookie)).toBe(true);

        fixture.expireSessionAfter(0);
        expect(await checkSignInPlain(guard, `${fixture.origin}/account`, signal)).toEqual({ ok: false, reason: "answered HTTP 401" });
        // Only GET, never a sign-in attempt.
        expect(fixture.requests.slice(from).every((r) => r.method === "GET" && r.path === "/account")).toBe(true);

        guard.endSignIn!();
        const before = fixture.requests.length;
        await guard.fetch(`${fixture.origin}/about`, { method: "GET" });
        await guard.fetch(`${fixture.origin}/.env`, { method: "GET", maxBytes: 4096 });
        const after = fixture.requests.slice(before);
        expect(after.map((r) => r.path)).toEqual(["/about", "/.env"]);
        expect(after.some((r) => String(r.headers.cookie ?? "").includes(FIXTURE_SESSION_COOKIE))).toBe(false);
        // Sign-out addresses stay refused all the same.
        expect(await guard.refusal(`${fixture.origin}/logout`)).toMatch(/sign-out address/);
        fixture.expireSessionAfter(null);
    });

    it("cannot tell (nothing decided) when the page is refused", async () => {
        const signal = new AbortController().signal;
        const guard = guardFor({ ...app(), excludedPaths: ["/account"] }, securitySettings({ SECURITY_ALLOW_PRIVATE_TARGETS: "true" }), signal, {}, { state: state(), refuseSignOut: true });
        expect(await checkSignInPlain(guard, `${fixture.origin}/account`, signal)).toBeUndefined();
    });
});

describe("the restore message's words for security data", () => {
    it("names what came back, authorizations as withdrawn", () => {
        expect(securityRestoreWords({ tests: 0, securityApplications: 1, securityAuthorizations: 1, securityAssessments: 3, securityFindings: 3 })).toBe(
            "1 application, 1 authorization (withdrawn: record a new one before the next assessment), 3 assessments and 3 findings",
        );
        expect(securityRestoreWords({ securityApplications: 2, securityAuthorizations: 0, securityAssessments: 0, securityFindings: 1 })).toBe("2 applications, 0 assessments and 1 finding");
        expect(securityRestoreWords({ securityApplications: 0, securityAuditLines: 2 })).toBe("the security assessment settings (no applications, assessments or findings)");
    });
});
