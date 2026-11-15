/**
 * The seeded-defect catalogue (src/eval/bench/catalogue.json): read only by the benchmark controller, never handed to the platform or the
 * engine. The controller needs a defect's id, app, workflow, category and severity; the other fields (expected, actual, steps, verifier)
 * are for people and the verifiers, and are kept as they are.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { REPO_ROOT } from "../../config.js";

export const CATALOGUE_FILE = path.join(REPO_ROOT, "src/eval/bench/catalogue.json");

const DefectSchema = z
    .object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/),
        app: z.string().min(1).max(48),
        workflow: z.string().min(1).max(120),
        category: z.string().min(1).max(60),
        severity: z.string().min(1).max(20),
    })
    .passthrough();
export type CatalogueDefect = z.infer<typeof DefectSchema>;

const CatalogueSchema = z
    .object({
        version: z.union([z.string().min(1).max(40), z.number()]).transform(String),
        defects: z.array(DefectSchema).min(1).max(200),
    })
    .passthrough()
    .superRefine((c, ctx) => {
        const seen = new Set<string>();
        c.defects.forEach((d, i) => {
            if (seen.has(d.id)) ctx.addIssue({ code: "custom", message: `The defect id “${d.id}” is used twice`, path: ["defects", i, "id"] });
            seen.add(d.id);
        });
    });

export interface Catalogue {
    version: string;
    /** sha256 of the file, so a result names exactly the catalogue it was judged against. */
    sha256: string;
    defects: CatalogueDefect[];
}

export function parseCatalogue(text: string): Catalogue {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`The defect catalogue is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = CatalogueSchema.safeParse(raw);
    if (!parsed.success) throw new Error(`The defect catalogue has problems: ${parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`);
    return { version: parsed.data.version, sha256: crypto.createHash("sha256").update(text).digest("hex"), defects: parsed.data.defects };
}

export function loadCatalogue(file = CATALOGUE_FILE): Catalogue {
    return parseCatalogue(fs.readFileSync(file, "utf8"));
}

export const defectsOf = (c: Catalogue, app: string): CatalogueDefect[] => c.defects.filter((d) => d.app === app);
