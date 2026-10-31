/**
 * The evaluation corpus: the real websites and Android apps the AI tester is measured on (`eval/corpus.json`, edited by the owner).
 *
 * The file never holds a secret. Sign-in details are the NAMES of environment variables (`"username": "SHOP_USER"`); the harness reads
 * their values when it runs and hands them to the platform like any other sign-in details (stored encrypted there, never in a result file).
 * Two built-in local fixtures (`fixture`) exist so the harness itself can be checked without any outside site, app or account.
 */
import fs from "node:fs";
import { z } from "zod";

/** Local fixtures the harness starts itself: the DemoShop sample site, and the mock shop app on the fake adb (no phone, no emulator). */
export const FIXTURES = ["sample-app", "fake-shop"] as const;
export type FixtureId = (typeof FIXTURES)[number];

export const MAX_ENTRIES = 100;
const ENV_NAME = z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use the NAME of an environment variable (capital letters, digits, _), never the value itself");

const Credentials = z
    .object({ username: ENV_NAME.optional(), password: ENV_NAME.optional(), apiToken: ENV_NAME.optional() })
    .strict()
    .refine((c) => Boolean(c.username) === Boolean(c.password), { message: "Give both username and password, or neither" });

const Targets = z.array(z.enum(["web", "api", "mobile"])).min(1).max(3);

export const CorpusEntrySchema = z
    .object({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "Use lower-case letters, digits and dashes (at most 48)"),
        kind: z.enum(["web", "android"]),
        /** web: the address to explore. Left out when `fixture` is "sample-app" (the harness knows its address). */
        url: z.string().url().max(2000).optional(),
        /** android: the app's package name. */
        appPackage: z
            .string()
            .regex(/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/, "Use the package name, e.g. com.example.shop")
            .max(200)
            .optional(),
        /** android: an .apk file (path on the computer that runs the harness) to install first. Optional. */
        apk: z.string().min(1).max(500).optional(),
        credentials: Credentials.optional(),
        /** What to explore. Default: ["web"] for a website, ["mobile"] for an Android app. */
        targets: Targets.optional(),
        /** Smaller numbers make a run faster and cheaper. */
        maxPages: z.number().int().min(1).max(100).optional(),
        maxScenarios: z.number().int().min(1).max(100).optional(),
        /** false: only journey tests (no accessibility, page health, security, input, contract or access checks). Default true. */
        checks: z.boolean().optional(),
        fixture: z.enum(FIXTURES).optional(),
        notes: z.string().max(2000).optional(),
    })
    .strict()
    .superRefine((e, ctx) => {
        if (e.kind === "web") {
            if (!e.url && e.fixture !== "sample-app") ctx.addIssue({ code: "custom", message: "A website needs its url", path: ["url"] });
            if (e.appPackage || e.apk) ctx.addIssue({ code: "custom", message: "appPackage and apk are for Android apps", path: ["appPackage"] });
            if (e.fixture === "fake-shop") ctx.addIssue({ code: "custom", message: "The fake-shop fixture is an Android app", path: ["fixture"] });
            if (e.targets?.includes("mobile")) ctx.addIssue({ code: "custom", message: "A website cannot have the mobile target", path: ["targets"] });
        } else {
            if (!e.appPackage && e.fixture !== "fake-shop") ctx.addIssue({ code: "custom", message: "An Android app needs its appPackage", path: ["appPackage"] });
            if (e.url) ctx.addIssue({ code: "custom", message: "url is for websites; an Android app is found by its appPackage", path: ["url"] });
            if (e.fixture === "sample-app") ctx.addIssue({ code: "custom", message: "The sample-app fixture is a website", path: ["fixture"] });
            if (e.targets && e.targets.some((t) => t !== "mobile")) ctx.addIssue({ code: "custom", message: "An Android app is explored with targets [\"mobile\"]", path: ["targets"] });
        }
        if (e.apk && !/\.apk$/i.test(e.apk)) ctx.addIssue({ code: "custom", message: "The apk file name must end in .apk", path: ["apk"] });
    });
export type CorpusEntry = z.infer<typeof CorpusEntrySchema>;

export const CorpusSchema = z
    .object({
        /** Shown in results and used to compare a run with the previous run of the same corpus. */
        name: z.string().trim().min(1).max(80).default("corpus"),
        entries: z.array(CorpusEntrySchema).max(MAX_ENTRIES),
    })
    .strict()
    .superRefine((c, ctx) => {
        const seen = new Set<string>();
        c.entries.forEach((e, i) => {
            if (seen.has(e.id)) ctx.addIssue({ code: "custom", message: `The id “${e.id}” is used twice`, path: ["entries", i, "id"] });
            seen.add(e.id);
        });
    });
export type Corpus = z.infer<typeof CorpusSchema>;

/** Largest corpus file read (a corpus is a short list, not data). */
export const MAX_CORPUS_BYTES = 256 * 1024;

/** One plain line per problem: "entries.2.url: A website needs its url". */
export function corpusProblems(err: z.ZodError): string[] {
    return err.issues.slice(0, 20).map((i) => `${i.path.length ? `${i.path.join(".")}: ` : ""}${i.message}`);
}

/** Read and check a corpus file. Throws an Error whose message lists every problem in plain words. */
export function loadCorpus(file: string): Corpus {
    let text: string;
    try {
        const size = fs.statSync(file).size;
        if (size > MAX_CORPUS_BYTES) throw new Error(`The corpus file is larger than ${MAX_CORPUS_BYTES / 1024} KB`);
        text = fs.readFileSync(file, "utf8");
    } catch (e) {
        throw new Error(`Could not read the corpus file ${file}: ${e instanceof Error ? e.message : String(e)}`);
    }
    return parseCorpus(text, file);
}

export function parseCorpus(text: string, where = "corpus"): Corpus {
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch (e) {
        throw new Error(`${where} is not valid JSON: ${e instanceof Error ? e.message : String(e)}`);
    }
    // Keys starting with "//" are comments (JSON has none), allowed at the top and inside entries.
    const parsed = CorpusSchema.safeParse(stripComments(raw));
    if (!parsed.success) throw new Error(`${where} has problems:\n  ${corpusProblems(parsed.error).join("\n  ")}`);
    return parsed.data;
}

function stripComments(v: unknown): unknown {
    if (Array.isArray(v)) return v.map(stripComments);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !k.startsWith("//")).map(([k, x]) => [k, stripComments(x)]));
    return v;
}

/** The targets an entry explores. */
export const targetsOf = (e: CorpusEntry): Array<"web" | "api" | "mobile"> => e.targets ?? (e.kind === "android" ? ["mobile"] : ["web"]);

/**
 * The sign-in details of an entry, read from the environment now. A name that is not set is reported, never guessed.
 * The values go to the platform only; nothing of them is kept by the harness.
 */
export function credentialsFromEnv(e: CorpusEntry, env: NodeJS.ProcessEnv = process.env): { values?: Record<string, string>; missing: string[] } {
    if (!e.credentials) return { missing: [] };
    const values: Record<string, string> = {};
    const missing: string[] = [];
    for (const [k, name] of Object.entries(e.credentials)) {
        if (!name) continue;
        const v = env[name];
        if (v === undefined || v === "") missing.push(name);
        else values[k] = v;
    }
    return { values: missing.length ? undefined : values, missing };
}
