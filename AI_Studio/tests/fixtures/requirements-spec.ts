/**
 * A requirements specification shaped like real ones: a title page, a document information table and a revision history, an
 * introduction in prose, headings between sections, and numbered requirements that each carry a title, a description, a reference
 * line, a priority and an "Acceptance criteria" list. The same document as a Word file (.docx, built here with real heading styles,
 * Word lists and tables), as Markdown with the author's own ids, and as plain text with typed numbers.
 *
 * `SPEC_EXPECTED` is what an import must find in it: exactly these four requirements, nothing from the title page, the tables, the
 * introduction, the headings or the glossary, and no acceptance criterion as a requirement of its own.
 */
import { strToU8, zipSync } from "fflate";

export interface ExpectedRequirement {
    title: string;
    description: string;
    reference: string;
    priority: "critical" | "high" | "medium" | "low";
    acceptanceCriteria: string[];
    section: string;
}

export const SPEC_EXPECTED: ExpectedRequirement[] = [
    {
        title: "User registration",
        description: "A visitor must be able to create an account with an email address and a password.",
        reference: "Business requirements document BRD-04, section 3.1",
        priority: "high",
        acceptanceCriteria: [
            "The registration form asks for a name, an email address and a password.",
            "An email address that is already registered shows \"This email is already in use\".",
            "The password must have at least 8 characters.",
            "A confirmation email is sent after the account is created.",
        ],
        section: "Accounts",
    },
    {
        title: "Sign in",
        description: "A registered user must be able to sign in with their email address and password. After five failed attempts the account is locked for 15 minutes.",
        reference: "BRD-04, section 3.2; user story US-12",
        priority: "high",
        acceptanceCriteria: ["A correct email address and password open the account page.", "A wrong password shows \"Email or password is incorrect\".", "The sixth attempt within 15 minutes is refused."],
        section: "Accounts",
    },
    {
        title: "Search books",
        description: "A shopper must be able to search the catalogue by title, author or ISBN.",
        reference: "BRD-04, section 4.1",
        priority: "medium",
        acceptanceCriteria: ["Results show the cover, title, author and price.", "A search with no match shows \"No books found\".", "An ISBN finds exactly one book."],
        section: "Catalogue",
    },
    {
        title: "Pay by card",
        description: "A shopper must be able to pay for the basket with a debit or credit card.",
        reference: "BRD-04, section 5.2; payment provider guide",
        priority: "critical",
        acceptanceCriteria: [
            "Given a basket with one book, when the shopper pays with a valid card, then the order confirmation shows the order number.",
            "Given a declined card, when the shopper pays, then the message \"Your card was declined\" is shown and no order is created.",
        ],
        section: "Checkout",
    },
];

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── Word ─────────────────────────────────────────────────────────────────────

type Block = { p: string; style?: string } | { li: string; num: 1 | 2 } | { table: string[][] };

const p = (text: string, style?: string): Block => ({ p: text, ...(style ? { style } : {}) });
const bullet = (text: string): Block => ({ li: text, num: 1 });
const numbered = (text: string): Block => ({ li: text, num: 2 });

function wordRequirement(n: number, r: ExpectedRequirement, priorityWord: string, criteriaAsNumbers = false): Block[] {
    const [first, ...rest] = r.description.split(/(?<=\.) (?=After)/);
    return [
        p(`Requirement ${n}: ${r.title}`, "Heading3"),
        p(`Description: ${first}`),
        ...rest.map((t) => p(t)),
        p(`Reference: ${r.reference}`),
        p(`Priority: ${priorityWord}`),
        p("Acceptance Criteria:"),
        ...r.acceptanceCriteria.map((c) => (criteriaAsNumbers ? numbered(c) : bullet(c))),
    ];
}

const [REG, SIGNIN, SEARCH, PAY] = SPEC_EXPECTED as [ExpectedRequirement, ExpectedRequirement, ExpectedRequirement, ExpectedRequirement];

const WORD_BODY: Block[] = [
    p("Online Bookstore", "Title"),
    p("Software Requirements Specification", "Subtitle"),
    p("Version 1.2"),
    p("Prepared by: Quality team"),
    p("Date: 12 March 2026"),
    p("Document information", "Heading1"),
    { table: [["Document ID", "SRS-BOOK-001"], ["Project", "Online Bookstore"], ["Version", "1.2"], ["Status", "Approved"], ["Owner", "Product team"]] },
    p("Revision history", "Heading1"),
    {
        table: [
            ["Version", "Date", "Author", "Description"],
            ["1.0", "02/02/2026", "Product team", "First draft of the requirements"],
            ["1.1", "20/02/2026", "Product team", "Added the checkout requirements"],
            ["1.2", "12/03/2026", "Quality team", "Acceptance criteria reviewed"],
        ],
    },
    p("1. Introduction", "Heading1"),
    p("1.1 Purpose", "Heading2"),
    p("This document describes what the online bookstore must do for shoppers. The test team must use it as the source of the test cases."),
    p("1.2 Scope", "Heading2"),
    p("The web shop is in scope. The warehouse system is out of scope and is described in its own document."),
    p("2. Functional requirements", "Heading1"),
    p("2.1 Accounts", "Heading2"),
    ...wordRequirement(1, REG, "High"),
    ...wordRequirement(2, SIGNIN, "High"),
    p("2.2 Catalogue", "Heading2"),
    ...wordRequirement(3, SEARCH, "Medium"),
    p("2.3 Checkout", "Heading2"),
    ...wordRequirement(4, PAY, "Critical", true),
    p("3. Glossary", "Heading1"),
    { table: [["Term", "Meaning"], ["ISBN", "International Standard Book Number, the id of a book"], ["Basket", "The books a shopper has chosen but not paid for yet"]] },
];

function wordXml(blocks: Block[]): string {
    const run = (t: string) => `<w:r><w:t xml:space="preserve">${esc(t)}</w:t></w:r>`;
    const para = (b: Block): string => {
        if ("table" in b) {
            return `<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>${b.table.map((row) => `<w:tr>${row.map((c) => `<w:tc><w:p>${run(c)}</w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
        }
        if ("li" in b) return `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${b.num}"/></w:numPr></w:pPr>${run(b.li)}</w:p>`;
        return `<w:p>${b.style ? `<w:pPr><w:pStyle w:val="${b.style}"/></w:pPr>` : ""}${run(b.p)}</w:p>`;
    };
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${blocks.map(para).join("")}</w:body></w:document>`;
}

const STYLE_NAMES: Record<string, string> = { Title: "Title", Subtitle: "Subtitle", Heading1: "heading 1", Heading2: "heading 2", Heading3: "heading 3", ListParagraph: "List Paragraph", TableGrid: "Table Grid" };

/** A .docx with styles.xml (so mammoth maps the headings) and numbering.xml (a bullet list and a numbered list). */
export function makeWordDocx(blocks: Block[] = WORD_BODY): Buffer {
    const W = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"`;
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles ${W}>${Object.entries(STYLE_NAMES)
        .map(([id, name]) => `<w:style w:type="${id === "TableGrid" ? "table" : "paragraph"}" w:styleId="${id}"><w:name w:val="${name}"/></w:style>`)
        .join("")}</w:styles>`;
    const abstract = (id: number, fmt: string, text: string) => `<w:abstractNum w:abstractNumId="${id}"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/></w:lvl></w:abstractNum>`;
    const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering ${W}>${abstract(0, "bullet", "•")}${abstract(1, "decimal", "%1.")}<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num><w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>`;
    const rel = (id: string, type: string, target: string) => `<Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/${type}" Target="${target}"/>`;
    const override = (part: string, type: string) => `<Override PartName="${part}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${type}+xml"/>`;
    return Buffer.from(
        zipSync({
            "[Content_Types].xml": strToU8(
                `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${override("/word/document.xml", "document.main")}${override("/word/styles.xml", "styles")}${override("/word/numbering.xml", "numbering")}</Types>`,
            ),
            "_rels/.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "officeDocument", "word/document.xml")}</Relationships>`),
            "word/_rels/document.xml.rels": strToU8(`<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rel("rId1", "styles", "styles.xml")}${rel("rId2", "numbering", "numbering.xml")}</Relationships>`),
            "word/document.xml": strToU8(wordXml(blocks)),
            "word/styles.xml": strToU8(styles),
            "word/numbering.xml": strToU8(numbering),
        }),
    );
}

// ── Markdown, with the author's own ids ──────────────────────────────────────

/** The author's ids in the Markdown version: kept as the references. */
export const SPEC_MD_IDS = ["FR-01", "FR-02", "FR-03", "FR-04"];

const mdRequirement = (id: string, r: ExpectedRequirement, priorityWord: string) =>
    [
        `### ${id}: ${r.title}`,
        "",
        `**Description:** ${r.description}`,
        "",
        `**Reference:** ${r.reference}`,
        "",
        `**Priority:** ${priorityWord}`,
        "",
        "**Acceptance criteria:**",
        "",
        ...r.acceptanceCriteria.map((c, i) => (id === "FR-04" ? `${i + 1}. ${c}` : `- ${c}`)),
        "",
    ].join("\n");

export const SPEC_MD = [
    "# Online Bookstore",
    "",
    "Software Requirements Specification",
    "",
    "Version: 1.2  ",
    "Prepared by: Quality team  ",
    "Date: 12 March 2026",
    "",
    "## Document information",
    "",
    "| Field | Value |",
    "| --- | --- |",
    "| Document ID | SRS-BOOK-001 |",
    "| Version | 1.2 |",
    "| Status | Approved |",
    "",
    "## Revision history",
    "",
    "| Version | Date | Author | Description |",
    "| --- | --- | --- | --- |",
    "| 1.0 | 2026-02-02 | Product team | First draft of the requirements |",
    "| 1.2 | 2026-03-12 | Quality team | Acceptance criteria reviewed |",
    "",
    "## 1. Introduction",
    "",
    "This document describes what the online bookstore must do for shoppers. The test team must use it as the source of the test cases.",
    "",
    "## 2. Functional requirements",
    "",
    "## 2.1 Accounts",
    "",
    mdRequirement("FR-01", REG, "High"),
    mdRequirement("FR-02", SIGNIN, "High"),
    "## 2.2 Catalogue",
    "",
    mdRequirement("FR-03", SEARCH, "Medium"),
    "## 2.3 Checkout",
    "",
    mdRequirement("FR-04", PAY, "Critical"),
    "## 3. Glossary",
    "",
    "- ISBN: International Standard Book Number, the id of a book.",
].join("\n");

// ── Plain text, typed numbers, no ids ────────────────────────────────────────

const txtRequirement = (n: string, r: ExpectedRequirement, priorityWord: string) =>
    [`${n} ${r.title}`, `Description: ${r.description}`, `Reference: ${r.reference}`, `Priority: ${priorityWord}`, "Acceptance criteria:", ...r.acceptanceCriteria.map((c) => `  * ${c}`), ""].join("\n");

export const SPEC_TXT = [
    "ONLINE BOOKSTORE",
    "Software Requirements Specification",
    "Document ID: SRS-BOOK-001",
    "Version: 1.2",
    "Status: Approved",
    "",
    "REVISION HISTORY",
    "1.0 | 02/02/2026 | Product team | First draft of the requirements",
    "1.2 | 12/03/2026 | Quality team | Acceptance criteria reviewed",
    "",
    "1 INTRODUCTION",
    "This document describes what the online bookstore must do for shoppers.",
    "",
    "2 FUNCTIONAL REQUIREMENTS",
    "",
    "Accounts",
    "--------",
    "",
    txtRequirement("2.1", REG, "High"),
    txtRequirement("2.2", SIGNIN, "High"),
    "Catalogue",
    "---------",
    "",
    txtRequirement("2.3", SEARCH, "Medium"),
    "Checkout",
    "--------",
    "",
    txtRequirement("2.4", PAY, "Critical"),
].join("\n");
