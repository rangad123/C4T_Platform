/**
 * Requirements-driven generation: document extraction (txt/md/docx/pdf), requirement parsing with
 * and without a model, requirement-aware planning, and coverage. No network, no real LLM: the
 * planner path uses AI SDK's MockLanguageModelV3 through the real structured-output parsing.
 */
import { generateText, Output } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import type { EngineContext } from "../src/engine/context.js";
import { unavailableLlmClient, type LlmClient } from "../src/engine/llm/provider.js";
import { planScenarios, requirementsCoverage } from "../src/engine/planning/planner.js";
import { extractDocumentText, RequirementsDocumentError } from "../src/engine/requirements/extract.js";
import { parseRequirements, parseRequirementsDeterministic, type Requirement } from "../src/engine/requirements/parse.js";
import type { AppModel } from "../src/engine/understanding/app-model.js";

const MD = `# DemoShop requirements

## 1. Authentication
- REQ-1: A registered user shall be able to log in with email and password.
- REQ-2: Login with a wrong password must show an error message.

## 2. Catalogue
- REQ-3: Users can search products by name.
- REQ-4: The site should respond within 200 ms.
`;

/** Minimal .docx: the three parts mammoth needs, zipped with fflate. */
function makeDocx(paragraphs: string[]): Buffer {
    const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
    return Buffer.from(
        zipSync({
            "[Content_Types].xml": strToU8(
                `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
            ),
            "_rels/.rels": strToU8(
                `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
            ),
            "word/document.xml": strToU8(
                `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
            ),
        }),
    );
}

/** Minimal valid PDF with one text line per entry; xref offsets computed so strict readers accept it. */
function makePdf(lines: string[]): Buffer {
    const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`);
    const text = lines.map((l, i) => `${i === 0 ? "" : "0 -18 Td "}(${esc(l)}) Tj`).join(" ");
    const stream = `BT /F1 12 Tf 72 720 Td ${text} ET`;
    const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ];
    let pdf = "%PDF-1.4\n";
    const offsets: number[] = [];
    objects.forEach((o, i) => {
        offsets.push(Buffer.byteLength(pdf));
        pdf += `${i + 1} 0 obj\n${o}\nendobj\n`;
    });
    const xref = Buffer.byteLength(pdf);
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
    pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
    return Buffer.from(pdf, "latin1");
}

const ctxWith = (llm: LlmClient): EngineContext => ({ config: loadConfig({}), llm, emit: () => undefined });

describe("document extraction", () => {
    it("reads txt and md as text", async () => {
        expect(await extractDocumentText({ name: "r.md", data: Buffer.from(MD) })).toContain("REQ-3: Users can search products by name.");
        expect(await extractDocumentText({ name: "r.txt", data: Buffer.from("REQ-9 The cart shall keep items.") })).toContain("REQ-9");
    });

    it("reads .docx", async () => {
        const text = await extractDocumentText({ name: "r.docx", data: makeDocx(["REQ-1: Users shall log in.", "REQ-2: Errors must be shown."]) });
        expect(text).toContain("REQ-1: Users shall log in.");
        expect(text).toContain("REQ-2: Errors must be shown.");
    });

    it("reads .pdf", async () => {
        const text = await extractDocumentText({ name: "r.pdf", data: makePdf(["REQ-1: Users shall log in.", "REQ-2: Search shall find products."]) });
        expect(text).toContain("REQ-1: Users shall log in.");
        expect(text).toContain("REQ-2: Search shall find products.");
    });

    it("rejects unsupported types", async () => {
        await expect(extractDocumentText({ name: "r.exe", data: Buffer.from("x") })).rejects.toBeInstanceOf(RequirementsDocumentError);
    });
});

describe("requirement parsing", () => {
    it("keeps the document's own ids, with sections", () => {
        const reqs = parseRequirementsDeterministic(MD);
        expect(reqs.map((r) => r.id)).toEqual(["REQ-1", "REQ-2", "REQ-3", "REQ-4"]);
        expect(reqs[0]!.section).toMatch(/Authentication/);
    });

    it("assigns unique ids when list numbering would collide across sections", () => {
        const reqs = parseRequirementsDeterministic("## Login\n1. Users can log in.\n2. Wrong password shows an error.\n\n## Search\n1. Users can search products.\n");
        expect(new Set(reqs.map((r) => r.id)).size).toBe(reqs.length);
        expect(reqs).toHaveLength(3);
    });

    it("falls back to the deterministic result when no model is configured", async () => {
        const reqs = await parseRequirements(ctxWith(unavailableLlmClient("no key")), MD);
        expect(reqs.map((r) => r.id)).toEqual(["REQ-1", "REQ-2", "REQ-3", "REQ-4"]);
    });
});

describe("requirement-aware planning", () => {
    const model: AppModel = {
        url: "http://shop.test", origin: "http://shop.test", siteType: "ecommerce", purpose: "Outdoor gear shop", features: ["login", "search"],
        pages: [], navigation: [], apis: [], journeys: [], externalDependencies: [], documentedTestCases: [],
        authentication: { required: true, loginPath: "/login", mechanisms: ["form"], loggedIn: true },
        stats: { pagesVisited: 0, pagesSkipped: 0, apisFound: 0, durationMs: 0 },
    };
    const reqs: Requirement[] = parseRequirementsDeterministic(MD);

    it("puts requirements in the prompt, keeps only real ids, and reports coverage", async () => {
        let prompt = "";
        const scenario = (title: string, requirements: string[]) => ({
            title, description: title, category: "Auth", type: "functional", priority: "high", startPath: "/login",
            preconditions: [], expectedResults: ["Something visible"], requiresAuth: false, requiredData: [], requirements,
        });
        const mock = new MockLanguageModelV3({
            doGenerate: async (options) => {
                prompt += JSON.stringify(options.prompt);
                const out = { scenarios: [scenario("Login succeeds", ["REQ-1"]), scenario("Login fails with a wrong password", ["REQ-2", "REQ-99"]), scenario("Search by name", ["REQ-3"])] };
                return {
                    content: [{ type: "text" as const, text: JSON.stringify(out) }],
                    finishReason: { unified: "stop" as const, raw: "stop" },
                    usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } },
                    warnings: [],
                };
            },
        });
        const llm: LlmClient = {
            modelName: "mock",
            model: mock,
            usage: { inputTokens: 0, outputTokens: 0 },
            object: async ({ system, prompt: p, schema }) => (await generateText({ model: mock, system, prompt: p, output: Output.object({ schema }) })).output as never,
            text: async () => "",
        };

        const scenarios = await planScenarios(ctxWith(llm), model, { maxScenarios: 10, hasCredentials: true, requirements: reqs });
        expect(prompt).toContain("[REQ-3]");
        expect(prompt).toContain("Requirements to cover");
        // the invented REQ-99 is dropped, real ids kept
        expect(scenarios[1]!.requirements).toEqual(["REQ-2"]);

        const coverage = requirementsCoverage(reqs, scenarios);
        expect(coverage.covered).toEqual(["REQ-1", "REQ-2", "REQ-3"]);
        expect(coverage.uncovered.map((u) => u.id)).toEqual(["REQ-4"]);
    });
});
