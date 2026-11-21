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
/** The bench extension (2026-11-21.1): seeds added to catalogue.json's when a run names that version, scored apart (`set: "extension"`). */
export const EXTENSION_CATALOGUE_FILE = path.join(REPO_ROOT, "src/eval/bench/catalogue-extension.json");

const DefectSchema = z
    .object({
        id: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,47}$/),
        app: z.string().min(1).max(48),
        workflow: z.string().min(1).max(120),
        category: z.string().min(1).max(60),
        severity: z.string().min(1).max(20),
        /** Why no test can reach it in this bench set-up (scoring v2: left out of the effective maximum, still counted as seeded). */
        unreachable: z.string().min(1).max(400).optional(),
        /** An extension seed: scored in the extension score, never in the original one. */
        set: z.literal("extension").optional(),
        /** Visible only in the stored data: unreachable in a trial without a database back end. */
        storedDataOnly: z.boolean().optional(),
    })
    .passthrough();
export type CatalogueDefect = z.infer<typeof DefectSchema>;
/** No test can reach the seed in this trial: the catalogue says so, or it shows only in the stored data and the trial has no database back end. */
export const isUnreachable = (d: Pick<CatalogueDefect, "unreachable" | "storedDataOnly">, withDatabase: boolean): boolean => !!d.unreachable || (!!d.storedDataOnly && !withDatabase);

const CatalogueSchema = z
    .object({
        version: z.union([z.string().min(1).max(40), z.number()]).transform(String),
        /** Each app's seeded fixture accounts (in the repository, not secrets): the --roles catalogue test accounts. */
        apps: z.record(z.string(), z.object({ accounts: z.array(z.object({ email: z.string().min(3).max(200), password: z.string().min(1).max(200) }).passthrough()).max(6) }).passthrough()).optional(),
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
    /** Each app's fixture accounts (email and password only). */
    accounts?: Record<string, Array<{ email: string; password: string }>>;
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
    const accounts = Object.fromEntries(Object.entries(parsed.data.apps ?? {}).map(([app, a]) => [app, a.accounts.map(({ email, password }) => ({ email, password }))]));
    return { version: parsed.data.version, sha256: crypto.createHash("sha256").update(text).digest("hex"), defects: parsed.data.defects, accounts };
}

export function loadCatalogue(file = CATALOGUE_FILE): Catalogue {
    return parseCatalogue(fs.readFileSync(file, "utf8"));
}

export const defectsOf = (c: Catalogue, app: string): CatalogueDefect[] => c.defects.filter((d) => d.app === app);

/**
 * The catalogue a run names: the base file's version (the default), or the extension's, which is the base defects plus the extension's
 * (each marked `set: "extension"`), with a sha256 over both files.
 */
export function loadCatalogueVersion(version: string | undefined, file = CATALOGUE_FILE, extensionFile = EXTENSION_CATALOGUE_FILE): Catalogue {
    const base = loadCatalogue(file);
    if (version === undefined || version === base.version) return base;
    const text = fs.readFileSync(extensionFile, "utf8");
    const ext = parseCatalogue(text);
    if (version !== ext.version) throw new Error(`There is no catalogue ${version} (known: ${base.version}, ${ext.version})`);
    const extends_ = (JSON.parse(text) as { extends?: unknown }).extends;
    if (extends_ !== base.version) throw new Error(`The catalogue ${ext.version} extends ${String(extends_)}, but the base catalogue is ${base.version}`);
    const ids = new Set(base.defects.map((d) => d.id));
    const twice = ext.defects.filter((d) => ids.has(d.id) || d.set !== "extension").map((d) => d.id);
    if (twice.length) throw new Error(`The catalogue ${ext.version} must add new defects marked "set": "extension" only: ${twice.join(", ")}`);
    return { version: ext.version, sha256: crypto.createHash("sha256").update(base.sha256).update(ext.sha256).digest("hex"), defects: [...base.defects, ...ext.defects], accounts: base.accounts };
}

export const isExtension = (d: Pick<CatalogueDefect, "set">): boolean => d.set === "extension";
