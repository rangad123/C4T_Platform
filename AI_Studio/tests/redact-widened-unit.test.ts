/**
 * The shared redaction (src/shared/redact-text.ts) covers the kinds the evidence audit found leaking (P5 L-4, L-5, L-6): URL-encoded
 * e-mails, phone numbers, postal addresses, card numbers (Luhn-checked), `bearer:` lines, well-known API key formats, and a query value
 * that is a secret once decoded (an encoded e-mail or connection string). Ids and slugs stay readable (row 232), as do dates, times,
 * addresses of servers and numbers that only look like a card.
 */
import { describe, expect, it } from "vitest";
import { maskText } from "../src/platform/redact-text.js";
import { EMAIL_HIDDEN, HIDDEN, redactText, secretsInText } from "../src/shared/redact-text.js";

const gone = (text: string, secret: string) => {
    const out = redactText(text);
    expect(out.includes(secret), `${secret} in ${out}`).toBe(false);
    return out;
};

describe("the widened kinds are hidden", () => {
    it("phone numbers in international and common national forms", () => {
        for (const p of ["+1 415 555 0111", "+44 20 7946 0958", "+91-98765-43210", "+14155550111", "(415) 555-0111", "415-555-0111", "415 555 0111"]) expect(gone(`phone: ${p} (call)`, p)).toContain(HIDDEN);
        expect(redactText("Call +1 415 555 0111 today")).toBe(`Call ${HIDDEN} today`);
    });

    it("card numbers that pass the Luhn check, grouped or not; one that fails it stays", () => {
        for (const c of ["4000 0012 3400 7011", "4000-0012-3400-7011", "4000001234007011", "5555 5555 5555 4444", "3782 822463 10005"]) expect(gone(`card ${c} declined`, c)).toBe(`card ${HIDDEN} declined`);
        expect(redactText("card 4000 0012 3400 7012 declined")).toBe("card 4000 0012 3400 7012 declined");
    });

    it("postal addresses (a number, capitalised words and a street word)", () => {
        expect(redactText("Ship to 111 Canary Lane, Springfield today")).toBe(`Ship to ${HIDDEN} today`);
        expect(redactText("221B Baker Street")).toBe(HIDDEN);
        for (const a of ["1600 Pennsylvania Avenue", "42 Elm St", "7 Old Mill Road, Little Snoring"]) expect(gone(a, a)).toContain(HIDDEN);
    });

    it("`bearer: x` lines and bearer=x pairs, without the Bearer scheme before the value", () => {
        expect(gone("bearer: cnryCoBearerTok6", "cnryCoBearerTok6")).toBe(`bearer: ${HIDDEN}`);
        expect(gone("/api/ping?bearer=cnryUrBearerTok5&x=1", "cnryUrBearerTok5")).toBe(`/api/ping?bearer=${HIDDEN}&x=1`);
        expect(gone('{"bearer":"cnryJsBearerTok4"}', "cnryJsBearerTok4")).toBe(`{"bearer":"${HIDDEN}"}`);
    });

    it("well-known API key formats without a key word", () => {
        for (const k of ["sk_" + "live_" + "cnryTxKey7Zp", "sk_" + "test_" + "4eC39HqLyjWDarjtT1zdp7dc", "ghp_canaryTrackerToken1234567890ab", "AKIAIOSFODNN7EXAMPLE", "xoxb-1234567890-abcdefghij"]) expect(gone(`shown: ${k}.`, k)).toBe(`shown: ${HIDDEN}.`);
    });

    it("URL-encoded e-mails, anywhere", () => {
        expect(redactText("/u/cnry.ur5%40people.example/profile")).toBe(`/u/${EMAIL_HIDDEN}/profile`);
    });

    it("a query value that is a secret once decoded: an e-mail, a phone, an address, a card, a connection string with its password", () => {
        const q = new URLSearchParams({ email: "cnry.ur5@people.example", phone: "+1 415 555 0155", address: "555 Canary Lane, Springfield", card: "4000 0012 3403 5053", dbUrl: "postgres://shop_admin:CnryDbUrPw5@db.internal:5432/shop", page: "2", q: "red shoes" }).toString();
        const out = redactText(`GET /api/ping?${q} -> 200`);
        expect(out).toBe(`GET /api/ping?email=${HIDDEN}&phone=${HIDDEN}&address=${HIDDEN}&card=${HIDDEN}&dbUrl=${HIDDEN}&page=2&q=red+shoes -> 200`);
    });

    it("a password in a connection string, plain or in a URL parameter", () => {
        expect(gone("connect postgres://shop_admin:CnryDbCoPw6@db.internal:5432/shop failed", "CnryDbCoPw6")).toBe(`connect postgres://${HIDDEN}@db.internal:5432/shop failed`);
        expect(gone("Server=db;User Id=shop;Password=CnryAdoPw1;Database=shop", "CnryAdoPw1")).toContain(`Password=${HIDDEN}`);
    });
});

describe("what is not a secret stays readable", () => {
    it("row 232: workflow ids and slugs are not masked", () => {
        for (const s of ["journey-1-sign-in-to-the-account", "journey-12-check-out-with-a-saved-card-2", "/blog/2026-11-21-how-we-test-the-checkout-page"]) expect(maskText(s)).toBe(s);
        // A random key's dash-cut parts mix letters with digits or capitals: still hidden.
        expect(maskText("wf-Ab3dE-f9GhIj-K1mNoPq-R2sTuVwX-yz45")).toContain(HIDDEN);
    });

    it("dates, times, versions, server addresses, ports, epoch times and numeric ids", () => {
        for (const s of [
            "2026-11-21 17:11:06",
            "on 21/11/2026 at 10:00",
            "v1.2.3.4",
            "http://192.168.100.200:5432/x",
            "127.0.0.1:5760",
            "run-1795261343890-e19a9ac7",
            "/api/orders/1234567890123456",
            "Order 4000 0012 3400 7012 lines",
            "3 Way handshake",
            "Status 200 in 415 ms, 555 bytes",
            "Room 101",
        ])
            expect(redactText(s), s).toBe(s);
    });
});

describe("secret-shaped page text (owner 2026-11-24, V9): a password, token or session id written as a bare word", () => {
    it("is hidden with nothing around it that marks it, in a sentence, a list or a snapshot line", () => {
        expect(redactText("Your password is CnryTxPw!7x9.")).toBe(`Your password is ${HIDDEN}.`);
        for (const w of ["CnryTxPw!7x9", "cnryTxBearerTok7", "cnryTxSessCk7q", "CnryIfPw!8x9", "aZ3kQ9mXp2", "Xk9#mP2qL"]) expect(gone(`shown (${w}) | next`, w)).toBe(`shown (${HIDDEN}) | next`);
    });

    it("product names, codes and identifiers stay: they change case at most twice, or have no digit", () => {
        for (const w of ["iPhone15ProMax", "MacBookPro2023", "PlayStation5", "addToCart2Btn", "AdminUser01", "SAVE10", "v2.3.1Beta", "!isA11yStep", "COVID19", "getElementById", "WelcomeBack10", "x9Y"]) expect(redactText(`Buy ${w} now`), w).toBe(`Buy ${w} now`);
    });

    it("secretsInText names it, so a trace masks it by value", () => {
        expect(secretsInText('["DIV",{"id":"t-password"},"CnryTxPw!7x9"]')).toEqual(["CnryTxPw!7x9"]);
    });
});

describe("secretsInText: the values the rules would hide, for masking by value elsewhere (traces)", () => {
    it("names the hidden values, not their keys", () => {
        const found = secretsInText("password: CnryCoPw!6x9 | phone: +1 415 555 0166 | see postgres://shop_admin:CnryDbCoPw6@db.internal/shop and cnry.co6@people.example");
        expect(found).toEqual(expect.arrayContaining(["CnryCoPw!6x9", "+1 415 555 0166", "CnryDbCoPw6", "cnry.co6@people.example"]));
        expect(found.some((f) => f.includes("password"))).toBe(false);
    });

    it("leaves out long hex and base64 runs (a trace's own ids look like them)", () => {
        expect(secretsInText("sha1 0123456789abcdef0123456789abcdef01234567 page@Ab3dE9f9GhIjK1mNoPqR2sTuVwXyz45ab")).toEqual([]);
    });
});

describe("where the widened redaction is applied", () => {
    it("an ARIA snapshot (the app model's page view, the AI's page view): secret and personal field values go, so do secret-shaped words; other page text stays", async () => {
        const { maskSnapshot } = await import("../src/engine/evidence/observed-text.js");
        const snap = [
            '- heading "Canary account" [level=1]',
            '- textbox "Access token": cnryFdBearerTok1',
            '- textbox "Session": cnryFdSessCk1q',
            '- textbox "E-mail": cnry.fd1@people.example',
            '- textbox "City": Springfield',
            "- text: Welcome back, call +1 415 555 0177",
            "- text: cnryTxSessCk7q",
            '- link "Share":',
            "  - /url: /?bearer=cnryUrBearerTok5&page=2",
        ].join("\n");
        const out = maskSnapshot(snap);
        for (const s of ["cnryFdBearerTok1", "cnryFdSessCk1q", "cnry.fd1@people.example", "+1 415 555 0177", "cnryUrBearerTok5", "cnryTxSessCk7q"]) expect(out.includes(s), s).toBe(false);
        for (const s of ['- heading "Canary account" [level=1]', '- textbox "City": Springfield', "- text: Welcome back, call", "- text: [hidden]", '- textbox "Access token": [hidden]', "page=2"]) expect(out, s).toContain(s);
    });

    it("text the app showed while the AI works (a dialog, a page error) loses secret-shaped words too", async () => {
        const { maskObservedText } = await import("../src/engine/evidence/observed-text.js");
        expect(maskObservedText("Your new session is cnryTxSessCk7q, keep it", [])).toBe(`Your new session is ${HIDDEN}, keep it`);
    });

    it("evidence is masked with it when it is stored and read (console lines, request paths)", async () => {
        const { parseEvidence } = await import("../src/engine/evidence/model.js");
        const raw = {
            v: 1,
            durationMs: 10,
            counts: { requests: 1, requestsKept: 1, console: 2, consoleKept: 2 },
            steps: [],
            requests: [{ t: 1, step: 1, method: "GET", type: "fetch", path: `/api/ping?${new URLSearchParams({ email: "cnry.ur5@people.example", dbUrl: "postgres://shop_admin:CnryDbUrPw5@db.internal:5432/shop" })}`, status: 200 }],
            console: [
                { t: 1, step: 1, type: "log", text: "phone: +1 415 555 0166 card: 4000 0012 3404 2067" },
                { t: 1, step: 1, type: "log", text: "bearer: cnryCoBearerTok6 at 666 Canary Lane, Springfield" },
            ],
        };
        const text = JSON.stringify(parseEvidence(JSON.stringify(raw)));
        for (const s of ["cnry.ur5", "CnryDbUrPw5", "+1 415 555 0166", "4000 0012 3404 2067", "cnryCoBearerTok6", "666 Canary Lane"]) expect(text.includes(s), s).toBe(false);
        expect(text).toContain("/api/ping?");
    });
});
