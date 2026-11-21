/**
 * The benchmark apps' requirements documents (examples/bench-<app>/requirements/requirements.md), which the detection benchmark imports
 * into every project it explores: each one is read by the platform's own requirements parser (no AI) into one requirement per numbered
 * line, with the document's own ids, and none of them names or hints at the seeded behaviours the benchmark measures: not the original
 * catalogue's, and not the bench extension's (catalogue-extension.json, 2026-11-21.1), whose seeds each cite their own requirement line.
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT } from "../src/config.js";
import { parseRequirementsDeterministic } from "../src/engine/requirements/parse.js";
import { BENCH_APPS, requirementsDocument } from "../src/eval/bench/apps.js";
import { CATALOGUE_FILE, loadCatalogue, loadCatalogueVersion } from "../src/eval/bench/catalogue.js";
import { candidatesFromText } from "../src/platform/requirement-store.js";

const docs = BENCH_APPS.map((app) => ({ app, doc: requirementsDocument(app) }));

describe("the benchmark apps' requirements documents", () => {
    it("every benchmark app, and every app the catalogue has seeded behaviours for, has one", () => {
        for (const { app, doc } of docs) expect(doc, app.id).toBeDefined();
        const withDocs = new Set(docs.filter((d) => d.doc).map((d) => d.app.id));
        for (const d of loadCatalogue(CATALOGUE_FILE).defects) expect(withDocs.has(d.app), d.app).toBe(true);
    });

    for (const { app, doc } of docs) {
        it(`${app.id}: parses into one requirement per numbered line, keeping the document's ids`, () => {
            const numbered = doc!.text.split("\n").flatMap((l) => /^- (\d+\.\d+) /.exec(l)?.[1] ?? []);
            expect(numbered.length).toBeGreaterThanOrEqual(30);
            expect(new Set(numbered).size).toBe(numbered.length);
            const parsed = parseRequirementsDeterministic(doc!.text);
            expect(parsed.map((r) => r.id)).toEqual(numbered);
            // What the benchmark imports: the import preview's records, one per requirement, under the same refs.
            expect(candidatesFromText(doc!.text).map((c) => c.ref)).toEqual(numbered);
            // The note at the top says what the document is.
            expect(doc!.text.split("\n").slice(0, 6).join(" ")).toMatch(/describes how \w+ is intended to behave/);
        });

        it(`${app.id}: names no seeded behaviour (no "BS-", "BR-", "seed", "defect" or "bug")`, () => {
            expect(doc!.text).not.toMatch(/BS-|BR-|seed|defect|bug/i);
        });

        it(`${app.id}: holds no seeded behaviour's description, original or extension, and each extension seed's requirement line exists`, () => {
            const all = loadCatalogueVersion("2026-11-21.1").defects.filter((d) => d.app === app.id);
            expect(all.some((d) => d.set === "extension")).toBe(true);
            for (const d of all) expect(doc!.text, d.id).not.toContain(String(d.actual));
            const numbered = new Set(doc!.text.split("\n").flatMap((l) => /^- (\d+\.\d+) /.exec(l)?.[1] ?? []));
            for (const d of all.filter((x) => x.set === "extension")) expect(numbered.has(String(d.requirement)), `${d.id} cites ${String(d.requirement)}`).toBe(true);
        });
    }

    it("the guard catches each banned word", () => {
        for (const bad of ["see BS-03", "BR-01 here", "the seeded cart", "a known defect", "this bug"]) expect(bad).toMatch(/BS-|BR-|seed|defect|bug/i);
    });

    it("the documents are files in the repository, next to their apps", () => {
        for (const { app } of docs) expect(fs.existsSync(path.join(REPO_ROOT, path.dirname(app.script), "requirements", "requirements.md")), app.id).toBe(true);
    });
});
