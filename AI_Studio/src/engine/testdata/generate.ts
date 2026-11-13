/**
 * Realistic test data for the fields of a form, with no model: names, emails on a reserved domain, phones in the fictional
 * 555-01xx range, dates, numbers in range, addresses, and boundary / invalid values for validation tests.
 *
 * Every value that names a record carries the run tag (e.g. "qa7k2q"), so records a run created do not collide with another
 * run's and can be found again (and cleaned up, see ../cleanup). Values are deterministic for a given seed: the same seed, tag
 * and order of requests give the same values. Without a seed they still differ per call (a counter per kind of field).
 */
import { tool } from "ai";
import { z } from "zod";
import { RUN_TAG, RUN_TAG_KEY } from "../cleanup/helper.js";

export { RUN_TAG, RUN_TAG_KEY };

/** What is known about one field (from the DOM: input type, name, label, autocomplete, pattern, limits, options). */
export interface FieldInfo {
    type?: string;
    name?: string;
    label?: string;
    placeholder?: string;
    autocomplete?: string;
    pattern?: string;
    min?: string | number;
    max?: string | number;
    step?: string | number;
    minLength?: number;
    maxLength?: number;
    /** A <select>'s or radio group's choices (values or labels). */
    options?: string[];
    required?: boolean;
}

export type FieldKind =
    | "email" | "phone" | "url" | "password" | "number" | "date" | "datetime" | "time" | "month" | "color" | "checkbox" | "choice"
    | "firstName" | "lastName" | "fullName" | "username" | "company" | "street" | "city" | "postalCode" | "country" | "birthDate"
    | "title" | "longText" | "search" | "text";

export interface EdgeValue {
    value: string;
    /** Should the form accept it? */
    valid: boolean;
    /** Plain words: what the value tests. */
    why: string;
}

/** The domain every generated email uses: reserved for examples (RFC 2606), so no mail ever reaches a person. */
export const TEST_EMAIL_DOMAIN = "example.com";

/** FNV-1a: a small, stable string hash. */
function hash(s: string): number {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return h >>> 0;
}

/** A seeded number in [0, 1) (mulberry32 step). */
function rand(seed: string): number {
    let t = (hash(seed) + 0x6d2b79f5) >>> 0;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

/** A run tag: from a seed (deterministic, e.g. a job id) or random. */
export function makeRunTag(seed?: string): string {
    const n = seed === undefined ? Math.floor(Math.random() * 36 ** 4) : hash(`tag:${seed}`) % 36 ** 4;
    return `qa${n.toString(36).padStart(4, "0")}`;
}

const FIRST = ["Ada", "Grace", "Alan", "Maya", "Ravi", "Lena", "Omar", "Sofia", "Kenji", "Amara", "Lucas", "Priya"];
const LAST = ["Lovelace", "Hopper", "Turing", "Patel", "Okafor", "Novak", "Silva", "Tanaka", "Haddad", "Larsen", "Moreau", "Kim"];
const STREETS = ["Maple", "Oak", "Cedar", "Elm", "Pine", "Willow", "Birch", "Harbor"];
const STREET_KINDS = ["Street", "Avenue", "Road", "Lane"];
const CITIES = ["Springfield", "Riverton", "Fairview", "Lakeside", "Greenville", "Milford"];
const COMPANIES = ["Acme Labs", "Northwind Testing", "Blue Harbor Co", "Summit Works"];
const TOPICS = ["Introduction to testing", "Quarterly review", "Team onboarding", "Spring workshop", "Product demo"];
const PLACEHOLDER_OPTION = /^[\s\-–—_.]*$|^\W*(select|choose|pick|please|none)\b/i;

const has = (f: FieldInfo, re: RegExp) => re.test([f.name, f.label, f.placeholder].filter(Boolean).join(" "));

/** What a field asks for, by input type, then autocomplete, then name / label / placeholder words. */
export function fieldKind(f: FieldInfo): FieldKind {
    const type = (f.type ?? "text").toLowerCase();
    const ac = (f.autocomplete ?? "").toLowerCase();
    if (f.options?.length && type !== "checkbox") return "choice";
    const byType: Record<string, FieldKind> = { email: "email", tel: "phone", url: "url", password: "password", number: "number", range: "number", date: "date", "datetime-local": "datetime", time: "time", month: "month", color: "color", checkbox: "checkbox", radio: "checkbox", search: "search" };
    if (byType[type] && !(type === "date" && (/bday/.test(ac) || has(f, /birth|dob/i)))) return byType[type]!;
    const byAc: Array<[RegExp, FieldKind]> = [[/email/, "email"], [/tel/, "phone"], [/given-name/, "firstName"], [/family-name/, "lastName"], [/^name$|\bname$/, "fullName"], [/username/, "username"], [/organization/, "company"], [/street-address|address-line/, "street"], [/address-level2/, "city"], [/postal-code/, "postalCode"], [/country/, "country"], [/bday/, "birthDate"], [/url/, "url"], [/password/, "password"]];
    for (const [re, k] of byAc) if (re.test(ac)) return k;
    if (type === "date" || has(f, /birth|dob/i)) return /bday/.test(ac) || has(f, /birth|dob/i) ? "birthDate" : "date";
    const byWords: Array<[RegExp, FieldKind]> = [
        [/e-?mail/i, "email"], [/phone|mobile|\btel\b|cell/i, "phone"], [/first.?name|given|fname/i, "firstName"], [/last.?name|surname|family|lname/i, "lastName"],
        [/user.?name|login|handle/i, "username"], [/company|organi[sz]ation|employer/i, "company"], [/street|address/i, "street"], [/city|town/i, "city"],
        [/zip|postal|postcode/i, "postalCode"], [/country/i, "country"], [/website|\burl\b|homepage|link/i, "url"],
        [/price|amount|qty|quantity|\bage\b|count|number|total|seats|capacity|years/i, "number"], [/\bdate\b|deadline|start|end|due/i, "date"],
        [/description|notes?\b|message|comment|bio|about|details|summary|body/i, "longText"], [/search|query|\bq\b/i, "search"],
        [/full.?name|your.?name|^name$|\bname\b/i, "fullName"], [/title|subject|heading|course|project|product|item|label/i, "title"],
    ];
    for (const [re, k] of byWords) if (has(f, re)) return k;
    return type === "textarea" ? "longText" : "text";
}

const num = (v: string | number | undefined): number | undefined => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? undefined : Number(v));
const iso = (d: Date) => d.toISOString().slice(0, 10);
const dateOf = (v: string | number | undefined): Date | undefined => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? new Date(`${v.slice(0, 10)}T00:00:00Z`) : undefined);
const DAY = 86_400_000;

function patternOk(pattern: string | undefined, value: string): boolean {
    if (!pattern) return true;
    try {
        return new RegExp(`^(?:${pattern})$`, "u").test(value);
    } catch {
        return true; // a pattern the browser could not use either is not enforced
    }
}

/** Fit a text to minLength / maxLength, keeping its end (the tag and counter, an email's domain) when it is too long. */
function fitLength(f: FieldInfo, v: string): string {
    let out = v;
    if (f.maxLength !== undefined && f.maxLength >= 0 && out.length > f.maxLength) out = out.slice(out.length - f.maxLength).trimStart();
    if (f.minLength !== undefined && out.length < f.minLength) out = out.padEnd(f.minLength, "x");
    return out;
}

export interface TestDataOptions {
    /** The run tag the values carry (default: random, or from the seed). */
    tag?: string;
    /** Same seed, same values (tests). */
    seed?: string;
    /** "Today" for dates (default: now). */
    now?: Date;
}

export interface TestData {
    readonly tag: string;
    /** What kind of field it is (email, phone, firstName...). */
    kind(f: FieldInfo): FieldKind;
    /** A realistic, valid value for the field; unique per call where the field names a record. */
    value(f: FieldInfo): string;
    /** Values for several fields of one record (e.g. a form), keyed by name or label. */
    record(fields: FieldInfo[]): Record<string, string>;
    /** Boundary values (accepted) and invalid ones (refused) for validation tests. */
    edges(f: FieldInfo): EdgeValue[];
}

/** A generator for one run: all its values carry the same tag. */
export function createTestData(opts: TestDataOptions = {}): TestData {
    const tag = opts.tag && RUN_TAG.test(opts.tag) ? opts.tag : makeRunTag(opts.seed);
    const seed = opts.seed ?? `${tag}:${Math.random()}`;
    const now = opts.now ?? new Date();
    const counters = new Map<string, number>();

    const raw = (f: FieldInfo, k: FieldKind, n: number): string => {
        const r = (what: string) => rand(`${seed}:${k}:${f.name ?? f.label ?? ""}:${n}:${what}`);
        const pick = <T,>(list: readonly T[], what: string): T => list[Math.floor(r(what) * list.length)]!;
        const first = pick(FIRST, "first");
        const last = pick(LAST, "last");
        switch (k) {
            case "email":
                return `${first}.${last}.${tag}.${n}@${TEST_EMAIL_DOMAIN}`.toLowerCase();
            case "phone":
                return `+1 202 555 01${String(Math.floor(r("phone") * 100)).padStart(2, "0")}`;
            case "url":
                return `https://${tag}-${n}.${TEST_EMAIL_DOMAIN}/`;
            case "password":
                return `Tq7!${tag}-Zx${n}`;
            case "number": {
                const min = num(f.min) ?? 1;
                const max = num(f.max) ?? Math.max(min + 99, min);
                const step = num(f.step) && num(f.step)! > 0 ? num(f.step)! : 1;
                const steps = Math.floor((max - min) / step);
                const v = min + Math.floor(r("n") * (steps + 1)) * step;
                return String(Number(v.toFixed(10)));
            }
            case "date":
            case "datetime":
            case "month":
            case "birthDate": {
                const lo = dateOf(f.min)?.getTime() ?? (k === "birthDate" ? Date.UTC(1965, 0, 1) : now.getTime() + DAY);
                const hi = dateOf(f.max)?.getTime() ?? (k === "birthDate" ? Date.UTC(2000, 11, 31) : now.getTime() + 60 * DAY);
                const d = new Date(lo + Math.floor(r("d") * (Math.max(0, hi - lo) / DAY + 1)) * DAY);
                return k === "datetime" ? `${iso(d)}T10:30` : k === "month" ? iso(d).slice(0, 7) : iso(d);
            }
            case "time":
                return `${String(9 + Math.floor(r("h") * 8)).padStart(2, "0")}:${pick(["00", "15", "30", "45"], "m")}`;
            case "color":
                return `#${Math.floor(r("c") * 0xffffff).toString(16).padStart(6, "0")}`;
            case "checkbox":
                return "checked";
            case "choice": {
                const real = (f.options ?? []).filter((o) => !PLACEHOLDER_OPTION.test(o));
                return real.length ? pick(real, "opt") : (f.options?.[0] ?? "");
            }
            case "firstName":
                return first;
            case "lastName":
                return `${last}-${tag}`;
            case "fullName":
                return `${first} ${last} ${tag}`;
            case "username":
                return `${first}_${tag}_${n}`.toLowerCase();
            case "company":
                return `${pick(COMPANIES, "co")} ${tag}`;
            case "street":
                return `${10 + Math.floor(r("no") * 890)} ${pick(STREETS, "st")} ${pick(STREET_KINDS, "sk")}`;
            case "city":
                return pick(CITIES, "city");
            case "postalCode":
                return String(10000 + Math.floor(r("zip") * 89999));
            case "country":
                return "United States";
            case "title":
                return `${pick(TOPICS, "topic")} ${tag} ${n}`;
            case "longText":
                return `Created by an automated test (${tag} ${n}). ${pick(TOPICS, "topic")}: safe to delete.`;
            case "search":
                return pick(TOPICS, "topic").split(" ")[0]!;
            default:
                return `Test ${tag} ${n}`;
        }
    };

    const value = (f: FieldInfo): string => {
        const k = fieldKind(f);
        const n = (counters.get(k) ?? 0) + 1;
        counters.set(k, n);
        const v = fitLength(f, raw(f, k, n));
        if (patternOk(f.pattern, v)) return v;
        // A pattern the realistic value misses: plain digits or letters of a fitting length, with the counter for uniqueness.
        const lengths = [f.maxLength, f.minLength, 8, ...Array.from({ length: 16 }, (_, i) => i + 1)].filter((x): x is number => x !== undefined && x > 0 && x <= 64);
        for (const len of lengths) for (const c of [String(n).padStart(len, "1"), `${tag}${n}`.padEnd(len, "a").slice(0, len), "A".repeat(len)]) if (patternOk(f.pattern, c)) return c;
        return v;
    };

    const edges = (f: FieldInfo): EdgeValue[] => {
        const k = fieldKind(f);
        const out: EdgeValue[] = [];
        if (f.required) out.push({ value: "", valid: false, why: "a required field left empty" });
        if (k === "number") {
            const min = num(f.min);
            const max = num(f.max);
            const step = num(f.step) && num(f.step)! > 0 ? num(f.step)! : 1;
            if (min !== undefined) out.push({ value: String(min), valid: true, why: "the smallest allowed number" }, { value: String(min - step), valid: false, why: "just below the smallest allowed number" });
            if (max !== undefined) out.push({ value: String(max), valid: true, why: "the largest allowed number" }, { value: String(max + step), valid: false, why: "just above the largest allowed number" });
            out.push({ value: "abc", valid: false, why: "letters in a number field" });
        } else if (k === "date" || k === "birthDate") {
            const min = dateOf(f.min);
            const max = dateOf(f.max);
            if (min) out.push({ value: iso(min), valid: true, why: "the earliest allowed date" }, { value: iso(new Date(min.getTime() - DAY)), valid: false, why: "the day before the earliest allowed date" });
            if (max) out.push({ value: iso(max), valid: true, why: "the latest allowed date" }, { value: iso(new Date(max.getTime() + DAY)), valid: false, why: "the day after the latest allowed date" });
        } else if (k === "email") {
            out.push({ value: "not-an-email", valid: false, why: "an email without @" }, { value: `name@`, valid: false, why: "an email without a domain" });
        } else if (k === "phone") {
            out.push({ value: "phone", valid: false, why: "letters in a phone number" });
        } else if (k === "url") {
            out.push({ value: "not a web address", valid: false, why: "text that is not a web address" });
        }
        if (f.maxLength !== undefined && f.maxLength > 0 && !["number", "date", "birthDate", "checkbox", "choice"].includes(k)) {
            const base = `${tag}-`.padEnd(f.maxLength + 1, "x");
            out.push({ value: base.slice(0, f.maxLength), valid: true, why: `exactly the longest allowed text (${f.maxLength} characters)` }, { value: base, valid: false, why: `one character more than allowed (${f.maxLength + 1})` });
        }
        if (f.minLength !== undefined && f.minLength > 1) {
            out.push({ value: tag.padEnd(f.minLength, "x").slice(0, f.minLength - 1), valid: false, why: `one character fewer than needed (${f.minLength - 1})` });
        }
        if (f.pattern && !patternOk(f.pattern, "!!")) out.push({ value: "!!", valid: false, why: "text that does not match the required format" });
        return out;
    };

    return {
        tag,
        kind: fieldKind,
        value,
        record: (fields) => Object.fromEntries(fields.map((f, i) => [f.name || f.label || `field${i + 1}`, value(f)])),
        edges,
    };
}

/** For the planner, when data-changing tests are on: plan create / edit / delete scenarios with generated data. */
export function testDataPlanningRule(o: { tag?: string }): string {
    return `- Tests that create, edit or delete records ARE allowed. Plan them (create, then edit or delete what the test itself created) with generated data: write "with generated data" in requiredData (e.g. "create a course with generated data"); the test fills each field with a realistic value tagged ${o.tag ?? "with the run tag"}, and the records it creates are removed after the run where the application allows it. Never edit or delete what the test did not create.`;
}


export const TEST_DATA_AUTHORING_NOTE = `
You also have a testValue tool: describe a form field (its type, name, label, autocomplete, pattern, limits, options) and it gives a realistic value tagged with this run's tag, or with kind "invalid"/"boundary" values for validation tests. Use it whenever the test creates or edits a record, and type exactly the value it gives.`;

const FieldSchema = z.object({
    type: z.string().optional(),
    name: z.string().optional(),
    label: z.string().optional(),
    placeholder: z.string().optional(),
    autocomplete: z.string().optional(),
    pattern: z.string().max(500).optional(),
    min: z.union([z.string(), z.number()]).optional(),
    max: z.union([z.string(), z.number()]).optional(),
    step: z.union([z.string(), z.number()]).optional(),
    minLength: z.number().int().min(0).max(100_000).optional(),
    maxLength: z.number().int().min(0).max(100_000).optional(),
    options: z.array(z.string()).max(200).optional(),
    required: z.boolean().optional(),
});

/** The authoring agent's testValue tool. `specData` is the spec's testData: the run tag is recorded there on first use. */
export function testValueTool(gen: TestData, specData: Record<string, string>, onAction?: (a: { tool: string; args: unknown; ok: boolean; observation: string }) => void) {
    return tool({
        description: "A realistic value for a form field (tagged with this run's tag), or invalid / boundary values for validation tests. Records no step: type the value with fill.",
        inputSchema: z.object({ field: FieldSchema, kind: z.enum(["valid", "invalid", "boundary"]).default("valid") }),
        execute: async ({ field, kind }) => {
            specData[RUN_TAG_KEY] = gen.tag;
            const edges = gen.edges(field);
            const observation =
                kind === "valid"
                    ? gen.value(field)
                    : JSON.stringify(edges.filter((e) => (kind === "invalid" ? !e.valid : e.valid)).map((e) => ({ value: e.value, why: e.why })));
            onAction?.({ tool: "testValue", args: { field, kind }, ok: true, observation });
            return kind === "valid" ? observation : observation === "[]" ? "No such values are known for this field." : observation;
        },
    });
}
