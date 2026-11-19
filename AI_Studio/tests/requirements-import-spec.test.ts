/**
 * Importing requirements from a real-shaped specification (tests/fixtures/requirements-spec.ts) as Word, Markdown and plain text:
 * each requirement's title is only its title, the description, reference and priority go to their own fields, the acceptance
 * criteria stay with their requirement (never requirements of their own, and saved with it), the title page, document information,
 * revision history, introduction and headings are not requirements, and the references the import gives are the project's REQ-n,
 * in order and without gaps, like requirements added by hand. Saved references never change.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { extractDocumentText, htmlToText } from "../src/engine/requirements/extract.js";
import { parseRequirementsDeterministic, type Requirement } from "../src/engine/requirements/parse.js";
import { bootstrap, type Platform } from "../src/platform/bootstrap.js";
import { candidatesFromText, candidatesWithAi } from "../src/platform/requirement-store.js";
import { buildServer } from "../src/platform/server.js";
import { addTest, seedProject, type Seed } from "./fixtures/dashboard-seed.js";
import { makeWordDocx, SPEC_EXPECTED, SPEC_MD, SPEC_MD_IDS, SPEC_TXT } from "./fixtures/requirements-spec.js";

const docxText = () => extractDocumentText({ name: "Bookstore SRS.docx", data: makeWordDocx() });

/** The fields a requirement must have been read into. */
function expectSpec(found: Requirement[]) {
    expect(found.map((r) => r.title)).toEqual(SPEC_EXPECTED.map((e) => e.title));
    found.forEach((r, i) => {
        const e = SPEC_EXPECTED[i]!;
        expect(r.description).toBe(e.description);
        expect(r.reference).toBe(e.reference);
        expect(r.priority).toBe(e.priority);
        expect(r.acceptanceCriteria).toEqual(e.acceptanceCriteria);
        expect(r.section).toMatch(new RegExp(`${e.section}$`));
    });
}

describe("reading a specification without AI", () => {
    it("finds exactly the four requirements of the Word document, each field in its place", async () => {
        const found = parseRequirementsDeterministic(await docxText());
        expectSpec(found);
        // The document numbered them only in their headings ("Requirement 1:"): the parser's ids, in order, no gaps.
        expect(found.map((r) => [r.id, r.numbered])).toEqual([["R-001", true], ["R-002", true], ["R-003", true], ["R-004", true]]);
    });

    it("reads the Markdown version the same way and keeps the author's ids", () => {
        const found = parseRequirementsDeterministic(SPEC_MD);
        expectSpec(found);
        expect(found.map((r) => r.id)).toEqual(SPEC_MD_IDS);
        expect(found.every((r) => !r.numbered)).toBe(true);
    });

    it("reads the plain-text version with typed numbers the same way", () => {
        expectSpec(parseRequirementsDeterministic(SPEC_TXT));
    });

    it("makes the import candidates: a clean title, the description with the reference, the criteria one per line", async () => {
        const c = candidatesFromText(await docxText());
        expect(c).toHaveLength(4);
        expect(c[1]).toMatchObject({
            ref: "",
            numbered: true,
            title: "Sign in",
            description: `${SPEC_EXPECTED[1]!.description}\n\nReference: ${SPEC_EXPECTED[1]!.reference}`,
            acceptanceCriteria: SPEC_EXPECTED[1]!.acceptanceCriteria.join("\n"),
            priority: "high",
        });
        // No title carries the description, the reference or the document's details.
        for (const x of c) expect(x.title).not.toMatch(/Description|Reference|Priority|Acceptance|SRS-BOOK|Requirement \d/);
    });

    it("keeps a Word table row on one line, so document information reads as a row", () => {
        expect(htmlToText("<table><tr><td><p>Document ID</p></td><td><p>SRS-BOOK-001</p></td></tr><tr><td><p>Version</p></td><td><p>1.2</p></td></tr></table>")).toBe("Document ID | SRS-BOOK-001\nVersion | 1.2");
    });

    it("never takes document information or a revision row for a requirement, also in a document without fields", () => {
        const found = parseRequirementsDeterministic("| Document ID | SRS-BOOK-001 |\n| Version | 1.2 |\n| 1.0 | 2026-02-02 | Product team | First draft |\n| 1.1 | 20/02/2026 | Product team | Added checkout |\n\n- REQ-1: Users can sign in.");
        expect(found.map((r) => r.id)).toEqual(["REQ-1"]);
    });

    it("attaches criteria given as AC-numbered lines and Given/When/Then lines to their requirement", () => {
        const found = parseRequirementsDeterministic(
            ["REQ-7: Logout", "Description: A signed-in user can sign out.", "Acceptance criteria:", "AC1: The sign-out button is on every page.", "AC2: After signing out the account page asks to sign in.", "", "REQ-8: Wishlist", "Acceptance criteria:", "Given a signed-in shopper", "When they add a book to the wishlist", "Then the wishlist shows it"].join("\n"),
        );
        expect(found.map((r) => [r.id, r.title, r.acceptanceCriteria])).toEqual([
            ["REQ-7", "Logout", ["The sign-out button is on every page.", "After signing out the account page asks to sign in."]],
            ["REQ-8", "Wishlist", ["Given a signed-in shopper When they add a book to the wishlist Then the wishlist shows it"]],
        ]);
    });
});

describe("reading a specification with the AI (scripted model)", () => {
    const fake = (answer: unknown) => ({ config: loadConfig({}), llm: { modelName: "fake", usage: { inputTokens: 0, outputTokens: 0 }, object: async () => answer } as never });

    it("keeps the fields and criteria when the model returns bare texts, and drops criteria it listed as requirements", async () => {
        const text = await docxText();
        const r = await candidatesWithAi(
            fake({
                requirements: [
                    { id: "R-001", text: "A visitor must be able to create an account with an email address and a password.", kind: "functional" },
                    { id: "", text: "The password must have at least 8 characters.", kind: "validation" },
                    { id: "R-002", text: "A registered user must be able to sign in.", kind: "security" },
                    { id: "R-003", text: "A shopper must be able to search the catalogue.", kind: "functional" },
                    { id: "R-004", text: "A shopper must be able to pay by card.", kind: "functional", acceptanceCriteria: ["Given a valid card, the order is confirmed."] },
                ],
            }),
            text,
        );
        expect(r.usedAi).toBe(true);
        expect(r.candidates.map((c) => [c.numbered, c.title])).toEqual([[true, "User registration"], [true, "Sign in"], [true, "Search books"], [true, "Pay by card"]]);
        expect(r.candidates[0]!.acceptanceCriteria).toBe(SPEC_EXPECTED[0]!.acceptanceCriteria.join("\n"));
        expect(r.candidates[3]!.acceptanceCriteria).toBe("Given a valid card, the order is confirmed.");
        expect(r.candidates[2]!.description).toContain("Reference: BRD-04, section 4.1");
    });
});

const KEY = "spec-import-key-6a7b8c9d";
let platform: Platform;
let app: Awaited<ReturnType<typeof buildServer>>;
let dir = "";
let S: Seed;

const call = async (method: string, url: string, payload?: unknown) => {
    const res = await app.inject({ method: method as "GET", url, headers: { "x-api-key": KEY }, ...(payload !== undefined ? { payload: payload as object } : {}) });
    return { status: res.statusCode, body: res.body ? (JSON.parse(res.body) as any) : null };
};
const reqs = () => `/api/projects/${S.projectId}/requirements`;
const file = (name: string, data: Buffer | string) => ({ file: { filename: name, contentBase64: Buffer.from(data).toString("base64") } });

beforeAll(async () => {
    for (const k of ["ANTHROPIC_API_KEY", "OPENAI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "LLM_API_KEY"]) process.env[k] = "";
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-spec-import-"));
    platform = bootstrap(loadConfig({ DATA_DIR: dir, SECRET_KEY: "spec-import-secret-0123456789", API_KEY: KEY, SCHEDULER_ENABLED: "false" }));
    app = await buildServer(platform);
    await app.ready();
    S = seedProject(platform, "Bookstore", "https://books.example.test");
    addTest(platform, S, "login");
}, 60_000);

afterAll(async () => {
    await app?.close();
    platform?.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

describe("importing the specification", () => {
    it("numbers imported requirements after the ones added by hand, in order and without gaps, with their criteria saved", async () => {
        for (const title of ["Home page shows new books", "Footer links work"]) expect((await call("POST", reqs(), { title })).body.ref).toMatch(/^REQ-[12]$/);
        // A project that imported before this change keeps its references: R-001 stays R-001, and so does its link.
        const old = await call("POST", reqs(), { ref: "R-001", title: "An older import" });
        const test = S.tests.get("login")!;
        expect((await call("POST", `${reqs()}/${old.body.id}/tests`, { automated: [test] })).status).toBe(200);

        const p = await call("POST", `${reqs()}/import/preview`, file("Bookstore SRS.docx", makeWordDocx()));
        expect(p.status).toBe(200);
        expect(p.body).toMatchObject({ total: 4, existing: 0, usedAi: false });
        expect(p.body.candidates.map((c: any) => [c.ref, c.numbered, c.title])).toEqual([
            ["REQ-3", true, "User registration"],
            ["REQ-4", true, "Sign in"],
            ["REQ-5", true, "Search books"],
            ["REQ-6", true, "Pay by card"],
        ]);

        // The person leaves "Sign in" out: the three kept still take REQ-3, REQ-4, REQ-5.
        const kept = p.body.candidates.filter((c: any) => c.title !== "Sign in").map((c: any) => ({ title: c.title, description: c.description, acceptanceCriteria: c.acceptanceCriteria, priority: c.priority }));
        const saved = await call("POST", `${reqs()}/import`, { requirements: kept });
        expect(saved.status).toBe(201);
        expect(saved.body.created).toBe(3);

        const list = (await call("GET", reqs())).body.requirements as any[];
        expect(list.map((r) => [r.ref, r.title])).toEqual([
            ["R-001", "An older import"],
            ["REQ-1", "Home page shows new books"],
            ["REQ-2", "Footer links work"],
            ["REQ-3", "User registration"],
            ["REQ-4", "Search books"],
            ["REQ-5", "Pay by card"],
        ]);
        const pay = list.find((r) => r.ref === "REQ-5");
        expect(pay).toMatchObject({ priority: "critical", source: "imported", acceptanceCriteria: SPEC_EXPECTED[3]!.acceptanceCriteria.join("\n") });
        expect(pay.description).toBe(`${SPEC_EXPECTED[3]!.description}\n\nReference: ${SPEC_EXPECTED[3]!.reference}`);
        expect(list.find((r) => r.ref === "R-001").tests.linked).toBe(1);

        // The next one added by hand follows on.
        expect((await call("POST", reqs(), { title: "Gift cards" })).body.ref).toBe("REQ-6");
    });

    it("keeps the document's own ids, and a numbered one never takes an id the same import brings", async () => {
        const p = await call("POST", `${reqs()}/import/preview`, file("bookstore.md", SPEC_MD));
        expect(p.body.candidates.map((c: any) => c.ref)).toEqual(SPEC_MD_IDS);
        const saved = await call("POST", `${reqs()}/import`, { requirements: [{ title: "Numbered" }, { ref: "REQ-7", title: "The document's REQ-7" }] });
        expect(saved.body).toMatchObject({ created: 2, duplicates: [] });
        const refs = (await call("GET", reqs())).body.requirements.map((r: any) => [r.ref, r.title]);
        expect(refs).toEqual(expect.arrayContaining([["REQ-7", "The document's REQ-7"], ["REQ-8", "Numbered"]]));
    });
});
