/**
 * Importing requirements from a real-shaped specification (tests/fixtures/requirements-spec.ts) as Word, Markdown and plain text:
 * each requirement's title is only its title, the description, reference and priority go to their own fields, the acceptance
 * criteria stay with their requirement (never requirements of their own, and saved with it), the title page, document information,
 * revision history, introduction and headings are not requirements, and the references the import gives are the project's REQ-n,
 * in order and without gaps, like requirements added by hand. Saved references never change.
 */
import { describe, expect, it } from "vitest";
import { extractDocumentText, htmlToText } from "../src/engine/requirements/extract.js";
import { parseRequirementsDeterministic, type Requirement } from "../src/engine/requirements/parse.js";
import { candidatesFromText } from "../src/platform/requirement-store.js";
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

    it("makes the import candidates: a clean title, the description with the reference, the priority", async () => {
        const c = candidatesFromText(await docxText());
        expect(c).toHaveLength(4);
        expect(c[1]).toMatchObject({
            ref: "R-002",
            title: "Sign in",
            description: `${SPEC_EXPECTED[1]!.description}\n\nReference: ${SPEC_EXPECTED[1]!.reference}`,
            priority: "high",
        });
        // No title carries the description, the reference or the document's details.
        for (const x of c) expect(x.title).not.toMatch(/Description|Reference|Priority|Acceptance|SRS-BOOK|Requirement \d/);
    });

    it("keeps a Word table row on one line, so document information reads as a row", () => {
        expect(htmlToText("<table><tr><td><p>Document ID</p></td><td><p>SRS-BOOK-001</p></td></tr><tr><td><p>Version</p></td><td><p>1.2</p></td></tr></table>")).toBe("Document ID | SRS-BOOK-001\nVersion | 1.2");
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
