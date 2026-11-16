/**
 * Secret hiding for application-knowledge text, rule by rule (pure, fast tier).
 */
import { describe, expect, it } from "vitest";
import { hideSecretLines, hideSecrets } from "../src/engine/intel/sources/hide-secrets.js";

describe("hideSecrets", () => {
    it("hides the project's own secrets wherever they appear", () => {
        const out = hideSecrets("Sign in with the code word tangerine-sky, then again tangerine-sky.", { secrets: ["tangerine-sky"] });
        expect(out).not.toContain("tangerine-sky");
        expect(out).toContain("Sign in with the code word");
    });

    it.each([
        ["Stripe", "sk_live_abcdef1234567890"],
        ["Stripe test", "pk_test_51Habcdefgh"],
        ["GitHub", "ghp_abcdefghij1234567890"],
        ["Slack", "xoxb-1234-abcdef-ghijkl"],
        ["AWS", "AKIAIOSFODNN7EXAMPLE"],
    ])("hides a known %s key format", (_name, key) => {
        expect(hideSecrets(`Use ${key} for this.`)).not.toContain(key);
    });

    it("hides the value after a secret word when it looks like a value", () => {
        expect(hideSecrets("Enter PIN 4921 at the till.")).not.toContain("4921");
        expect(hideSecrets("The otp is 735102 today.")).not.toContain("735102");
    });

    it("hides tokens shaped like a strong password", () => {
        const out = hideSecrets("Login with admin / S3cretP@ss as the operator, then try Winter2026!");
        expect(out).not.toContain("S3cretP@ss");
        expect(out).not.toContain("Winter2026!");
        expect(out).toContain("Login with admin");
    });

    it("keeps ordinary words after a secret word and ordinary ids and numbers", () => {
        const text = "The password needs at least 8 characters; token expired shows an error. See TC-001, WEB-007, version 3.0.3, quantity 1 to 10, code SAVE10.";
        expect(hideSecrets(text)).toBe(text);
    });

    it("keeps paths, links and placeholders", () => {
        const text = "Open /api/orders/{id} at https://shop.example/cart with {{email}}.";
        expect(hideSecrets(text)).toBe(text);
    });
});

describe("hideSecretLines", () => {
    it("hides the line after a bare 'password:' even when the value does not look like one", () => {
        expect(hideSecretLines(["Admin password:", "bluebirdsky", "Next line stays."])).toEqual(["Admin password:", "[hidden]", "Next line stays."]);
    });

    it("keeps the line after a sentence about the password that does not end in a colon", () => {
        expect(hideSecretLines(["The password must be long", "bluebirdsky stays"])).toEqual(["The password must be long", "bluebirdsky stays"]);
    });
});
