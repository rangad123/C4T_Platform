/**
 * KNOWN-LIMITS-P3 T-9 (Phase 5 E2): the forms of a run's secret that masking by value missed, and secret field names it did not know.
 *   - hex (lower and upper case), quoted-printable, upper and lower case, HTML entities (named, decimal, hex), twice URL-encoded, and the
 *     secret split across a line (as written and JSON-escaped): masked in stored text (maskText), the action log and the trace scrub's
 *     forms (one list, agent-protocol/secret-variants.ts);
 *   - a secret word in another language, or one joined to a digit (`Clave1`, `senha1`, `pin1`, `nip1`): a secret field for the action log,
 *     the Explorer pictures and the proof screenshot cover.
 * What is not the secret stays as it was: the same ids, slugs, dates and numbers as tests/redact-widened-unit.test.ts.
 */
import { describe, expect, it } from "vitest";
import { secretVariants } from "../src/agent-protocol/secret-variants.js";
import { isSensitiveField, PROOF_SECRET_FIELDS } from "../src/engine/evidence/proof-style.js";
import { traceSecretForms } from "../src/engine/evidence/trace-scrub.js";
import { maskAction } from "../src/engine/explore/action-mask.js";
import { maskText } from "../src/platform/redact-text.js";
import { HIDDEN } from "../src/shared/redact-text.js";
import { namesSecretField } from "../src/shared/secret-field.js";

const PW = "Hunt3r!pw22";
const hex = Buffer.from(PW).toString("hex");
const FORMS: Record<string, string> = {
    hex,
    "upper-case hex": hex.toUpperCase(),
    "quoted-printable": "Hunt3r=21pw22",
    "upper case": PW.toUpperCase(),
    "lower case": PW.toLowerCase(),
    "HTML decimal entity": "Hunt3r&#33;pw22",
    "HTML hex entity": "Hunt3r&#x21;pw22",
    "twice URL-encoded": encodeURIComponent(encodeURIComponent(PW)),
    "split across a line": "Hunt3r\n!pw22",
    "split across a Windows line": "Hun\r\nt3r!pw22",
    "split, JSON-escaped": "Hunt3r!p\\nw22",
};

describe("T-9: every form of a run's secret is masked by value", () => {
    for (const [name, form] of Object.entries(FORMS)) {
        it(name, () => {
            expect(secretVariants(PW)).toContain(form);
            const stored = maskText(`error: the server echoed ${form} back`, [PW]);
            expect(stored).not.toContain(form);
            expect(stored).toContain(HIDDEN);
            expect(maskAction(`navigate http://127.0.0.1:9/s/${form}`, [PW])).not.toContain(form);
        });
    }

    it("an HTML-escaped echo of a password with & and \" in it (named entities)", () => {
        const pw = `Tr0ub&dor"x9`;
        const esc = pw.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
        expect(maskText(`Request failed: 500 <input name=pw value="${esc}">`, [pw])).not.toContain(esc);
    });

    it("splits are only ever made with a line break in them, and long secrets are not split (their plain form is still masked)", () => {
        expect(secretVariants(PW).filter((v) => v.length === PW.length && v !== PW && v.toLowerCase() !== PW.toLowerCase())).toEqual([]);
        const long = "k".repeat(30) + "Z9".repeat(30);
        expect(secretVariants(long).some((v) => /\n/.test(v))).toBe(false);
        expect(maskText(`token ${long} end`, [long])).not.toContain(long);
    });
});

describe("T-9: the forms list stays right as secrets change, and stays small for what a trace shows", () => {
    it("masking with one run's secrets and then another's masks each run's own (the forms list is not stale)", () => {
        expect(maskText("first Hunt3r!pw22 x", ["Hunt3r!pw22"])).toBe("first [hidden] x");
        expect(maskText("second Other#Pw77 x", ["Other#Pw77"])).toBe("second [hidden] x");
        expect(maskText("again Hunt3r!pw22 and Other#Pw77", ["Hunt3r!pw22"])).toBe("again [hidden] and Other#Pw77");
    });

    it("a trace's own values get no line splits; the run's secrets do", () => {
        expect(traceSecretForms([PW]).some((f) => f.includes("\n"))).toBe(true);
        expect(traceSecretForms(["cnryValue1Tok7x"], false).some((f) => f.includes("\n") || f.includes("\\n"))).toBe(false);
    });
});

describe("T-9: what is not the secret stays readable with the run's secret in play", () => {
    it("the same ids, slugs, dates and numbers as before, and parts of the secret on their own", () => {
        for (const s of [
            "journey-1-sign-in-to-the-account",
            "/blog/2026-11-21-how-we-test-the-checkout-page",
            "2026-11-21 17:11:06",
            "on 21/11/2026 at 10:00",
            "v1.2.3.4",
            "127.0.0.1:5760",
            "run-1795261343890-e19a9ac7",
            "/api/orders/1234567890123456",
            "Status 200 in 415 ms, 555 bytes",
            "Room 101",
            "Hunt3r",
            "HUNT3R",
            "pw22",
            "Order 48756e74 shipped",
            "The hunter went out at 3",
        ])
            expect(maskText(s, [PW]), s).toBe(s);
    });
});

describe("T-9: secret field names in other languages and joined to a digit", () => {
    it("are secret fields", () => {
        for (const n of ["Clave1", "clave2", "senha1", "pin1", "nip1", "PIN-Code", "contraseña2", "passwort2", "password1", "Pass2", "2fa code"]) expect(namesSecretField(n), n).toBe(true);
    });

    it("words that only contain them, and ordinary numbered names, are not", () => {
        for (const n of ["spinner", "shipping", "pinned", "Pinterest", "item1", "Room 12", "step2", "version1", "nipple guard", "palabra"]) expect(namesSecretField(n), n).toBe(false);
    });

    it("the action log hides what was typed into them", () => {
        const masked = maskAction(`fill textbox "Clave1" @abc {"value":"Hunt3rXpw22"}`, []);
        expect(masked).not.toContain("Hunt3rXpw22");
        expect(maskAction(`fill textbox "Pin1" @abc {"value":"482913"}`, [])).not.toContain("482913");
    });

    it("the proof screenshot and the snapshot rule cover them; an ordinary search box stays uncovered", () => {
        expect(isSensitiveField({ name: "clave1", "aria-label": "Clave1" })).toBe(true);
        expect(isSensitiveField({ "aria-label": "Senha" })).toBe(true);
        expect(isSensitiveField({ "aria-label": "Contraseña" })).toBe(true);
        expect(PROOF_SECRET_FIELDS).toContain('input[name*="clave" i]');
        expect(isSensitiveField({ name: "q", "aria-label": "Search" })).toBe(false);
    });
});
