/**
 * Small web-app rules found in an audit (no browser, no server): what a refused sign-in says now that Settings has no access-key
 * card, and links made from addresses other systems send back (issue trackers, Sentry, device farms) keeping only http(s).
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../web/src/api.js";
import { downloadErrorText, KitError } from "../web/src/features/agents/kit.js";
import { describeApiError, signedOutText } from "../web/src/lib/labels.js";
import { externalHref } from "../web/src/lib/url.js";

describe("a refused sign-in (401)", () => {
    const SIGNED_OUT = "You are signed out, or the access key was not accepted. Reload the page to sign in again.";

    it("never sends the person to an access-key card in Settings", () => {
        for (const text of [describeApiError(new ApiError(401, "Missing or invalid x-api-key")), downloadErrorText(new KitError(401, "Missing or invalid x-api-key")).text]) {
            expect(text).toBe(SIGNED_OUT);
            expect(text).not.toMatch(/settings/i);
        }
    });

    it("keeps the server's own sentence when it says what to do", () => {
        expect(describeApiError(new ApiError(401, "Your Crowd4Test session needs renewing"))).toBe("Your Crowd4Test session needs renewing");
        const ticket = "This live-update link was already used or has expired. Reload the page to get a new one.";
        expect(describeApiError(new ApiError(401, ticket))).toBe(ticket);
        expect(signedOutText("Sign in first, or send an access key or a personal API token")).toBe(SIGNED_OUT);
        expect(signedOutText("Unauthorized")).toBe(SIGNED_OUT);
        expect(signedOutText("")).toBe(SIGNED_OUT);
    });
});

describe("links to other systems", () => {
    it("keep http and https addresses", () => {
        expect(externalHref("https://acme.atlassian.net/browse/SHOP-12")).toBe("https://acme.atlassian.net/browse/SHOP-12");
        expect(externalHref("http://jira.local:8080/browse/A-1")).toBe("http://jira.local:8080/browse/A-1");
    });

    it("drop any other scheme, so a tracker's answer cannot run script in the page", () => {
        for (const bad of ["javascript:alert(document.cookie)", " JavaScript:alert(1)", "data:text/html,<script>alert(1)</script>", "vbscript:msgbox(1)", "not a url", "", null, undefined]) {
            expect(externalHref(bad)).toBeUndefined();
        }
    });
});
