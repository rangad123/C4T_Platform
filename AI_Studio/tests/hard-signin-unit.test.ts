/**
 * Hard sign-ins, browser-free (fast tier): reading emails (MIME) and taking the code or link out of them, the IMAP reader against a
 * fake IMAP server (plain and TLS), saved sessions and forwarded mail at rest (encrypted), the email step in a generated script (the
 * helper really runs against the platform's answering loop), the saved-session line a run adds, captcha recognition, the text phrases
 * and the step editor's rules.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { captchaFromRequests, captchaMessage, CAPTCHA_FINDING_START } from "../src/engine/auth/captcha.js";
import { captchaFinding } from "../src/engine/auth/captcha-run.js";
import { EMAIL_HELPER_SOURCE, NO_MAILBOX_MESSAGE } from "../src/engine/auth/email-step.js";
import { answerFrom, extractCode, extractLink, mailFromFields, parseRawMail, type MailMessage } from "../src/engine/auth/mail.js";
import { startMailRpc } from "../src/engine/auth/mail-rpc.js";
import { prepareRunExtras, SESSION_LINE, withSessionLine } from "../src/engine/auth/run-session.js";
import { cookieMatchesHost, parseStorageState, secretValuesOf, sessionExpiry, type StorageState } from "../src/engine/auth/storage-state.js";
import { checkSpecInput } from "../src/engine/builder/index.js";
import { readStepLine } from "../src/engine/dsl/parser.js";
import { printStep } from "../src/engine/dsl/printer.js";
import { playwrightGenerator } from "../src/engine/generators/playwright.js";
import { describeStep, TestSpecSchema, type Step } from "../src/engine/spec/schema.js";
import { Db } from "../src/platform/db.js";
import { signInAgainMessage, signsInByItself } from "../src/platform/hard-signin-service.js";
import { imapNewest, imapSinceDate, parseInternalDate, plainImapProblem, testImap } from "../src/platform/mailbox/imap.js";
import { mailSourceFor } from "../src/platform/mailbox/feed.js";
import { Repo } from "../src/platform/repo.js";
import { SecretBox } from "../src/platform/secrets.js";
import { SessionStore } from "../src/platform/session-store.js";
import { rawMail, startFakeImap, type FakeImap } from "./fixtures/fake-imap.js";
import { removeMintedTls, selfSignedTls, TLS_SKIP_REASON } from "./fixtures/tls-files.js";

const PORT_IMAP = 6830;
const PORT_IMAPS = 6831;
const ORIGIN = "http://localhost:6832";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-wa-unit-"));
afterAll(() => {
    removeMintedTls();
    try {
        fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
        /* Windows may hold the database file a moment longer */
    }
});

const mail = (o: Partial<MailMessage>): MailMessage => ({ to: ["qa@mail.test"], from: "noreply@app.test", subject: "", receivedAt: Date.now(), text: "", html: "", ...o });

// ── emails ──────────────────────────────────────────────────────────────────
describe("reading an email", () => {
    it("reads a multipart message: quoted-printable text, base64 HTML, an encoded subject, every recipient header", () => {
        const raw = rawMail({ to: "Q A <QA+1@Mail.test>", subject: "=?utf-8?B?" + Buffer.from("Votre code ✓").toString("base64") + "?=", text: "Your code is 482913.\nThanks", html: '<p>Click <a href="http://localhost:6832/magic?t=a&amp;b=1">Sign in</a></p>' });
        const m = parseRawMail(raw.replace("MIME-Version", "Delivered-To: other@mail.test\r\nMIME-Version"), 1000);
        expect(m.to).toEqual(["qa+1@mail.test", "other@mail.test"]);
        expect(m.subject).toBe("Votre code ✓");
        expect(m.text).toContain("Your code is 482913.");
        expect(m.html).toContain("magic?t=a&amp;b=1");
        expect(m.receivedAt).toBe(1000);
    });

    it("takes the code after a code word, ignores years and prices, and falls back to the first six-digit number", () => {
        expect(extractCode(mail({ text: "Hello Ada, it is 2026. Your verification code: 5531. It costs $123456 nothing." }))).toBe("5531");
        expect(extractCode(mail({ subject: "Welcome", text: "Use 908172 to continue (order 12)." }))).toBe("908172");
        expect(extractCode(mail({ html: "<p>Your one-time passcode is <b>AB12CD</b></p>" }))).toBe("AB12CD");
        expect(extractCode(mail({ text: "Order 42 shipped in 2026." }))).toBeUndefined();
        // With `after`, the first code after that text.
        expect(extractCode(mail({ text: "Old code 111111. New code for you: 222222" }), "for you:")).toBe("222222");
        expect(extractCode(mail({ text: "nothing" }), "for you:")).toBeUndefined();
    });

    it("opens only links to the application's own site, skips unsubscribe links, and can pick by text", () => {
        const m = mail({ html: `<a href="https://tracker.example/unsubscribe">Unsubscribe</a> <a href="${ORIGIN}/magic?t=xyz">Sign in now</a> <a href="${ORIGIN}/help">Help</a>`, text: `or paste ${ORIGIN}/magic?t=xyz.` });
        expect(extractLink(m, ORIGIN)).toEqual({ link: `${ORIGIN}/magic?t=xyz` });
        expect(extractLink(m, ORIGIN, "help")).toEqual({ link: `${ORIGIN}/help` });
        expect(extractLink(mail({ text: "Go to https://evil.example/login now" }), ORIGIN)).toEqual({ error: expect.stringContaining("goes to evil.example, not to the application's own site") });
        expect(extractLink(mail({ text: "no links" }), ORIGIN)).toEqual({ error: "The email has no link to open." });
        expect(answerFrom(mail({ text: "no code here" }), { use: "code", origin: ORIGIN })).toEqual({ error: expect.stringContaining("The email has no code") });
    });

    it("builds a message from forwarded fields", () => {
        const m = mailFromFields({ to: ["A <QA@Mail.test>", "b@mail.test"], subject: "Hi", text: "code 123456" }, 5);
        expect(m.to).toEqual(["qa@mail.test", "b@mail.test"]);
        expect(extractCode(m)).toBe("123456");
    });
});

// ── IMAP ────────────────────────────────────────────────────────────────────
const LOCAL_TLS = selfSignedTls("localhost");
if (!LOCAL_TLS) console.warn(TLS_SKIP_REASON);
describe.skipIf(!LOCAL_TLS)("the IMAP reader", () => {
    let imap: FakeImap;
    let imaps: FakeImap;
    beforeAll(async () => {
        imap = await startFakeImap({ port: PORT_IMAP, user: "qa@mail.test", pass: 'p"w\\1' });
        imaps = await startFakeImap({ port: PORT_IMAPS, user: "qa@mail.test", pass: "pw-tls", tls: { key: LOCAL_TLS!.key, cert: LOCAL_TLS!.cert } });
    });
    afterAll(async () => {
        await imap.close();
        await imaps.close();
    });

    it("finds the newest message to the address since the step started, reading only (EXAMINE, BODY.PEEK)", async () => {
        const since = Date.now();
        imap.add(rawMail({ to: "qa+old@mail.test", subject: "old", text: "code 000000" }), since - 10 * 60_000);
        imap.add(rawMail({ to: "qa+1@mail.test", subject: "first", text: "Your code is 111111" }), since + 1000);
        imap.add(rawMail({ to: "qa+1@mail.test", subject: "second", text: "Your code is 222222" }), since + 2000);
        imap.add(rawMail({ to: "qa+2@mail.test", subject: "other", text: "Your code is 333333" }), since + 3000);
        const cfg = { host: "127.0.0.1", port: PORT_IMAP, tls: false, user: "qa@mail.test", password: 'p"w\\1' };
        const found = await imapNewest(cfg, "qa+1@mail.test", since);
        expect(found.map((m) => m.subject)).toEqual(["second", "first"]);
        expect(await imapNewest(cfg, "qa+old@mail.test", since)).toEqual([]);
        expect(imap.commands.some((c) => /EXAMINE "INBOX"/.test(c))).toBe(true);
        expect(imap.commands.some((c) => /BODY\.PEEK\[\]/.test(c))).toBe(true);
        expect(imap.commands.some((c) => /STORE|EXPUNGE|DELETE|SELECT/i.test(c))).toBe(false);
        expect((await imapNewest(cfg, "QA+1@mail.test", since))[0]!.text).toContain("222222");
    });

    it("says plainly when the login is refused, and never allows plain IMAP to a public server", async () => {
        expect(await testImap({ host: "127.0.0.1", port: PORT_IMAP, tls: false, user: "qa@mail.test", password: "wrong" })).toMatch(/^The mailbox refused the user name or password/);
        expect(await testImap({ host: "127.0.0.1", port: PORT_IMAP, tls: false, user: "qa@mail.test", password: 'p"w\\1' })).toBeUndefined();
        expect(plainImapProblem({ host: "imap.example.com", tls: false })).toMatch(/only allowed for a mail server on this computer or a private network/);
        expect(plainImapProblem({ host: "10.1.2.3", tls: false })).toBeUndefined();
        expect(await testImap({ host: "127.0.0.1", port: 6849, tls: false, user: "u", password: "p" })).toMatch(/could not be reached/);
    });

    it("reads over TLS", async () => {
        const since = Date.now();
        imaps.add(rawMail({ to: "qa@mail.test", subject: "tls", text: "code 777777" }), since + 500);
        const got = await imapNewest({ host: "127.0.0.1", port: PORT_IMAPS, tls: true, user: "qa@mail.test", password: "pw-tls" }, "qa@mail.test", since, { tlsOptions: { rejectUnauthorized: false } });
        expect(got[0]!.subject).toBe("tls");
    });

    it("speaks IMAP's dates", () => {
        expect(parseInternalDate("17-Oct-2026 10:00:00 +0200")).toBe(Date.UTC(2026, 9, 17, 8, 0, 0));
        expect(imapSinceDate(Date.UTC(2026, 9, 17, 0, 30))).toBe("16-Oct-2026");
    });
});

// ── stored ──────────────────────────────────────────────────────────────────
const STATE: StorageState = {
    cookies: [
        { name: "sid", value: "SENTINEL-COOKIE-9f8e7d", domain: "localhost", path: "/", expires: Math.floor(Date.now() / 1000) + 3600, httpOnly: true, secure: false, sameSite: "Lax" },
        { name: "theme", value: "dark", domain: ".localhost", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    ],
    origins: [{ origin: ORIGIN, localStorage: [{ name: "token", value: "SENTINEL-STORAGE-123456" }] }],
};

describe("saved sessions and forwarded mail at rest", () => {
    const dbFile = path.join(tmp, "db.sqlite");
    const db = new Db(dbFile);
    const secrets = new SecretBox(tmp, "x".repeat(32));
    const repo = new Repo(db, secrets);
    repo.ensureDefaultUser();
    const projectId = String(repo.createProject({ name: "WA" }).id);
    const store = new SessionStore(db, secrets);
    afterAll(() => db.close());

    it("keeps a session encrypted, shows only facts about it, and knows when it runs out", () => {
        const pub = store.saveSession(projectId, "main", { state: STATE, appUrl: ORIGIN, checkUrl: `${ORIGIN}/dashboard`, how: "file" });
        expect(pub).toMatchObject({ account: "main", cookies: 2, how: "file", state: "ok", checkOk: null });
        expect(Date.parse(pub.expiresAt!)).toBeGreaterThan(Date.now());
        expect(JSON.stringify(store.listSessions(projectId))).not.toMatch(/SENTINEL/);
        expect(fs.readFileSync(dbFile).includes("SENTINEL")).toBe(false);
        expect(store.sessionState(projectId, "main")!.state.cookies[0]!.value).toBe("SENTINEL-COOKIE-9f8e7d");
        store.recordCheck(projectId, "main", false, "The page asks for a password again.");
        expect(store.publicSession(projectId, "main")).toMatchObject({ state: "expired", checkOk: false });
        expect(store.forgetSession(projectId, "main")).toBe(true);
        expect(store.listSessions(projectId)).toEqual([]);
    });

    it("reads the cookies' expiry and the values to mask", () => {
        expect(sessionExpiry(STATE, ORIGIN)!.getTime()).toBe(STATE.cookies[0]!.expires * 1000);
        expect(sessionExpiry({ cookies: [STATE.cookies[1]!], origins: [] }, ORIGIN)).toBeUndefined();
        expect(secretValuesOf(STATE)).toEqual(["SENTINEL-COOKIE-9f8e7d", "SENTINEL-STORAGE-123456"]);
        expect(cookieMatchesHost(".example.com", "app.example.com")).toBe(true);
        expect(cookieMatchesHost("example.com", "badexample.com")).toBe(false);
        expect(() => parseStorageState("{nope")).toThrow(/not valid JSON/);
        expect(() => parseStorageState({ cookies: "x" })).toThrow(/does not look like a browser storage state/);
        expect(() => parseStorageState("x".repeat(1_000_001))).toThrow(/too large/);
    });

    it("keeps forwarded mail encrypted, finds the newest to an address, and only for its project", async () => {
        const { token } = store.setMailbox(projectId, { kind: "inbound" });
        expect(store.projectForToken(token!)).toBe(projectId);
        expect(store.projectForToken("x".repeat(30))).toBeUndefined();
        const t0 = Date.now();
        store.addInbound(projectId, mailFromFields({ to: "qa@mail.test", subject: "a", text: "SENTINEL-MAIL code 123123" }, t0 - 60_000));
        store.addInbound(projectId, mailFromFields({ to: "qa@mail.test", subject: "b", text: "code 456456" }, t0));
        expect(fs.readFileSync(dbFile).includes("SENTINEL-MAIL")).toBe(false);
        const source = mailSourceFor(store, projectId)!;
        expect((await source({ to: "QA@mail.test", since: t0 - 1000 }))!.subject).toBe("b");
        expect(await source({ to: "qa@mail.test", since: t0 + 60_000 })).toBeUndefined();
        const other = String(repo.createProject({ name: "Other" }).id);
        expect(mailSourceFor(store, other)).toBeUndefined();
        expect(store.newestInbound(other, "qa@mail.test", 0)).toBeUndefined();
        // Old mail goes after a day.
        store.pruneInbound(projectId, t0 + 25 * 60 * 60 * 1000);
        expect(store.newestInbound(projectId, "qa@mail.test", 0)).toBeUndefined();
        expect(store.publicMailbox(projectId)).toEqual({ kind: "inbound", messages: 0 });
    });
});

// ── the email step in a script ──────────────────────────────────────────────
const spec = (steps: unknown[]) => TestSpecSchema.parse({ testId: "WEB-001", title: "Sign up with an emailed code", kind: "web", steps, testData: { addr: "qa+{{unique}}@mail.test" } });
const codeStep = { action: "email", to: "{{addr}}", use: "code", locator: { by: "label", value: "Code" } };
const linkStep = { action: "email", to: "{{addr}}", use: "link", after: "magic" };

describe("the email step in a generated script", () => {
    it("is described plainly and written as text both ways", () => {
        const s = spec([{ action: "navigate", url: "/signup" }, codeStep, linkStep]);
        expect(describeStep(s.steps[1]!)).toBe('Wait for an email to {{addr}} and type its code into label "Code"');
        expect(describeStep(s.steps[2]!)).toBe('Wait for an email to {{addr}} and open its link containing "magic"');
        for (const st of s.steps.slice(1)) {
            const line = printStep(st as Step)!;
            const { description: _d, ...want } = st as Step & { description?: string };
            expect(readStepLine(line)!.step).toEqual(want);
        }
    });

    it("adds the helper only to scripts that wait for an email; others are unchanged", () => {
        const plain = playwrightGenerator.render(spec([{ action: "navigate", url: "/" }]), { baseUrl: ORIGIN }).content;
        expect(plain).not.toContain("waitForEmail");
        expect(plain).not.toContain("AITP_MAIL_DIR");
        const s = playwrightGenerator.render(spec([{ action: "navigate", url: "/signup" }, codeStep, linkStep]), { baseUrl: ORIGIN }).content;
        expect(s).toContain("await waitForEmail(");
        expect(s).toContain("test.setTimeout(");
        for (const bad of ["sk-", "api_key", "TEST_PASSWORD", "password:"]) expect(s).not.toContain(bad);
        expect(() => playwrightGenerator.render(spec([{ action: "email", to: "a@b.test", use: "code" }]), { baseUrl: ORIGIN })).toThrow(/needs the field/);
    });

    it("the helper really asks the run's mailbox and gets the code, the link, or a plain error", async () => {
        const js = ts.transpileModule(`${EMAIL_HELPER_SOURCE}\nexport { waitForEmail };`, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
        const file = path.join(tmp, "helper.mjs");
        fs.writeFileSync(file, js);
        const { waitForEmail } = (await import(`file://${file.replace(/\\/g, "/")}`)) as { waitForEmail: (to: string, use: string, after: string, base: string) => Promise<string> };
        delete process.env.AITP_MAIL_DIR;
        await expect(waitForEmail("qa@mail.test", "code", "", ORIGIN)).rejects.toThrow(NO_MAILBOX_MESSAGE);

        const inbox: MailMessage[] = [];
        const rpc = await startMailRpc(path.join(tmp, "mail"), async ({ to, since }) => inbox.filter((m) => m.to.includes(to) && m.receivedAt >= since).at(-1), { pollMs: 50, waitMs: 1500, scanMs: 25 });
        process.env.AITP_MAIL_DIR = rpc.dir;
        try {
            setTimeout(() => inbox.push(mail({ to: ["qa@mail.test"], text: "Your code is 654321", html: `<a href="${ORIGIN}/magic?t=1">Sign in</a>` })), 200);
            await expect(waitForEmail("qa@mail.test", "code", "", ORIGIN)).resolves.toBe("654321");
            await expect(waitForEmail("qa@mail.test", "link", "", ORIGIN)).resolves.toBe(`${ORIGIN}/magic?t=1`);
            await expect(waitForEmail("nobody@mail.test", "code", "", ORIGIN)).rejects.toThrow("No email to nobody@mail.test arrived within 2 seconds.");
            await expect(waitForEmail("qa@mail.test", "link", "", "http://other.test")).rejects.toThrow(/not to the application's own site/);
        } finally {
            delete process.env.AITP_MAIL_DIR;
            await rpc.stop();
        }
    });
});

// ── a run that starts signed in ─────────────────────────────────────────────
describe("starting a run signed in", () => {
    it("adds one line after the Playwright import, only in the run's copy, and removes the session file afterwards", async () => {
        const content = playwrightGenerator.render(spec([{ action: "navigate", url: "/dashboard" }]), { baseUrl: ORIGIN }).content;
        expect(withSessionLine(content)).toContain(`import { test, expect } from "@playwright/test";\n${SESSION_LINE}`);
        expect(withSessionLine("// hand-written, no standard import")).toBe("// hand-written, no standard import");
        const dir = fs.mkdtempSync(path.join(tmp, "run-"));
        const extras = await prepareRunExtras(dir, [{ content, session: true }, { content }], JSON.stringify(STATE), undefined);
        expect(extras.env.AITP_STORAGE_STATE).toBe(path.join(dir, ".signed-in.json"));
        expect(fs.existsSync(extras.env.AITP_STORAGE_STATE!)).toBe(true);
        expect(extras.content({ content, session: true })).toContain(SESSION_LINE);
        expect(extras.content({ content })).toBe(content);
        expect(extras.secrets).toContain("SENTINEL-COOKIE-9f8e7d");
        await extras.end();
        expect(fs.existsSync(path.join(dir, ".signed-in.json"))).toBe(false);
        // No session, no email step: nothing at all.
        const none = await prepareRunExtras(dir, [{ content }], undefined, async () => undefined);
        expect(none.env).toEqual({});
    });

    it("leaves scripts that sign in by themselves signed out, and says plainly when the sign-in no longer works", () => {
        expect(signsInByItself('await page.fill("#p", process.env.TEST_PASSWORD ?? "")')).toBe(true);
        expect(signsInByItself("process.env.TEST_ADMIN_PASSWORD")).toBe(true);
        expect(signsInByItself('await page.goto("/dashboard")')).toBe(false);
        expect(signInAgainMessage("main", "The page asks for a password again.")).toBe("The saved sign-in for this project no longer works (The page asks for a password again). Sign in again under Test accounts, then run again. No test was run, so no result changed.");
    });
});

// ── captchas ────────────────────────────────────────────────────────────────
describe("captchas", () => {
    it("are recognised from the requests a page made, and reported in one plain sentence", () => {
        expect(captchaFromRequests([{ host: "www.google.com", path: "/recaptcha/api2/anchor?k=1" }])).toBe("reCAPTCHA");
        expect(captchaFromRequests([{ path: "/recaptcha/api.js" }])).toBe("reCAPTCHA");
        expect(captchaFromRequests([{ host: "js.hcaptcha.com", path: "/1/api.js" }])).toBe("hCaptcha");
        expect(captchaFromRequests([{ host: "challenges.cloudflare.com", path: "/turnstile/v0/api.js" }])).toBe("Turnstile");
        expect(captchaFromRequests([{ host: "www.google.com", path: "/search" }, { path: "/app.js" }])).toBeUndefined();
        expect(captchaMessage("hCaptcha", "/login")).toBe(`${CAPTCHA_FINDING_START} (hCaptcha) at /login; use a saved session or ask the site to turn it off for tests.`);
    });

    it("turn a failed web run into the captcha sentence when its evidence shows one", () => {
        const ev = path.join(tmp, "ev.json");
        fs.writeFileSync(ev, JSON.stringify({ v: 1, requests: [{ t: 1, step: 1, method: "GET", type: "script", path: "/recaptcha/api.js" }] }));
        expect(captchaFinding({ kind: "web" }, { status: "failed", artifacts: [{ kind: "evidence", path: ev }] })).toMatch(/^This page has a captcha \(reCAPTCHA\)/);
        expect(captchaFinding({ kind: "web" }, { status: "passed", artifacts: [{ kind: "evidence", path: ev }] })).toBeUndefined();
        expect(captchaFinding({ kind: "api" }, { status: "failed", artifacts: [{ kind: "evidence", path: ev }] })).toBeUndefined();
        expect(captchaFinding({ kind: "web" }, { status: "failed", artifacts: [] })).toBeUndefined();
    });
});

// ── the step editor ─────────────────────────────────────────────────────────
describe("the step editor", () => {
    it("asks for an address, and for a field when the step types a code", () => {
        const problems = (steps: unknown[]) => JSON.stringify(checkSpecInput({ title: "Emailed code", steps }, { testId: "WEB-001", kind: "web", category: "General", source: { origin: "manual" } }).diagnostics);
        expect(problems([{ action: "email", to: "", use: "link" }])).toContain("enter the address the email is sent to");
        expect(problems([{ action: "email", to: "a@b.test", use: "code" }])).toContain("choose the field to type the code into");
        expect(problems([{ action: "email", to: "a@b.test", use: "link" }])).not.toContain("email");
    });
});
