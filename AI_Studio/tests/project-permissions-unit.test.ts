/**
 * What the page assumes about the person's permissions in one project (web/src/features/auth/project-access-rules.ts): the project's own
 * list when it is known, the platform-wide one while it is not (a failed read changes nothing), and everything in open mode and
 * for an access key.
 */
import { describe, expect, it } from "vitest";
import { NO_PERMISSION_HERE, fullAccess, hereOf, whyNot } from "../web/src/features/auth/project-access-rules.js";

describe("hereOf", () => {
    it("follows the project's list when it is known", () => {
        const here = hereOf(["ai_studio.access", "ai_studio.tests.run"], false, () => true);
        expect(here.known).toBe(true);
        expect(here.may("ai_studio.tests.run")).toBe(true);
        expect(here.may("ai_studio.tests.write")).toBe(false);
        expect(here.why("ai_studio.tests.write")).toBe(NO_PERMISSION_HERE["ai_studio.tests.write"]);
        expect(here.why("ai_studio.tests.run")).toBeUndefined();
    });

    it("uses the platform-wide permissions while the project's list is not known", () => {
        const here = hereOf(undefined, false, (p) => p === "ai_studio.tests.write");
        expect(here.known).toBe(false);
        expect(here.may("ai_studio.tests.write")).toBe(true);
        expect(here.may("ai_studio.project.settings")).toBe(false);
    });

    it("assumes nothing without a platform answer either", () => {
        expect(hereOf(undefined, false).may("ai_studio.platform.settings")).toBe(true);
    });

    it("assumes everything in open mode and for an access key while the project's list is not known", () => {
        for (const kind of ["open", "key"]) {
            expect(fullAccess(kind)).toBe(true);
            const here = hereOf(undefined, fullAccess(kind), () => false);
            expect(here.may("ai_studio.tests.delete")).toBe(true);
            expect(here.why("ai_studio.project.members")).toBeUndefined();
        }
        expect(fullAccess("user")).toBe(false);
        expect(fullAccess(undefined)).toBe(false);
    });

    it("follows the server's list once it is known, whatever the session (the server sends every permission to open mode and keys)", () => {
        expect(hereOf(["ai_studio.access"], true).may("ai_studio.tests.run")).toBe(false);
    });

    it("has a sentence for every permission, in plain words without exclamation marks", () => {
        expect(whyNot("ai_studio.security.use")).toMatch(/Ask a Project Admin\.$/);
        for (const s of Object.values(NO_PERMISSION_HERE)) expect(s).not.toMatch(/!/);
    });
});
