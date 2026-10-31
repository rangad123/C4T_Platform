/**
 * Maestro flow import: turns Maestro YAML flows (https://maestro.mobile.dev, Apache-2.0) into our canonical test specs.
 *
 * Pure and deterministic: nothing is executed, no file or network is touched, and no value of a Maestro `env:` variable is ever
 * copied (a `${PASSWORD}` becomes the placeholder `{{credentials.password}}`, any other `${NAME}` becomes `{{env.NAME}}`, which the
 * script reads from the run's environment). What cannot be converted is reported per step with the reason, never dropped silently.
 *
 * Only a documented subset is supported (see docs/features/notifications-and-import.md). The result is checked against
 * `TestSpecSchema`, so whatever this module returns can be stored and rendered by the normal pipeline.
 */
import { parseAllDocuments } from "yaml";
import { VARIABLE_NAME } from "../environments/env.js";
import { TestSpecSchema, type Locator, type Step } from "../spec/schema.js";

export const MAESTRO_MAX_FLOWS = 100;
export const MAESTRO_MAX_BYTES = 200 * 1024;

export interface MaestroFile {
    name: string;
    content: string;
}

export interface StepNote {
    /** 1-based position of the command in the flow (commands inside an inline `runFlow` are counted in order). */
    step: number;
    command: string;
    /** `skipped`: the step is not in the test. `adjusted`: it is in the test, with a difference worth knowing. */
    level: "skipped" | "adjusted";
    reason: string;
}

export interface FlowVariable {
    /** The name in the Maestro flow. */
    name: string;
    /** What the generated test reads instead. */
    placeholder: string;
}

export interface ImportedSpecInput {
    title: string;
    description: string;
    kind: "mobile" | "web";
    category: string;
    type: "functional";
    priority: "medium";
    steps: Step[];
    tags: string[];
    source: { origin: "imported" };
}

export interface FlowReport {
    file: string;
    status: "converted" | "skipped";
    /** Why the whole flow was left out. */
    reason?: string;
    title?: string;
    kind?: "mobile" | "web";
    appId?: string;
    url?: string;
    /** Commands that ended up as steps of the test (a `launchApp` that needs no step does not count). */
    convertedSteps: number;
    /** Checks (assertions) among them. */
    checks: number;
    notes: StepNote[];
    variables: FlowVariable[];
    spec?: ImportedSpecInput;
}

/** The YAML of a file cannot be read at all (as opposed to a file that is readable but not a flow). */
export class MaestroSyntaxError extends Error {
    constructor(
        public readonly file: string,
        message: string,
    ) {
        super(message);
    }
}

/** Android application ids / iOS bundle ids look like `com.example.app`. */
const APP_ID = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/;
const USERNAME_VARS = /^(USERNAME|USER|USER_NAME|USER_EMAIL|EMAIL|LOGIN)$/i;
const PASSWORD_VARS = /^(PASSWORD|PASS|PASSWD|PWD)$/i;
const DIRECTIONS = ["up", "down", "left", "right"] as const;
type Direction = (typeof DIRECTIONS)[number];

/** Raised inside the converter for one command that cannot be converted; becomes a `skipped` note. */
class Unsupported extends Error {}

const isMap = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const asText = (v: unknown): string | undefined => (typeof v === "string" ? v : typeof v === "number" || typeof v === "boolean" ? String(v) : undefined);

interface Ctx {
    kind: "mobile" | "web";
    steps: Step[];
    notes: StepNote[];
    variables: Map<string, string>;
    /** The element the last `tapOn` named: Maestro's `inputText` types into the field that tap focused. */
    lastTarget?: Locator;
    counter: number;
    /** Guards against deeply nested inline flows. */
    depth: number;
}

/** `${NAME}` placeholders in a Maestro string → ours. Anything cleverer (a script expression) cannot be converted. */
function interpolate(text: string, ctx: Ctx): string {
    if (text.includes("{{")) throw new Unsupported("The text contains “{{”, which is reserved for placeholders here.");
    return text.replace(/\$\{([^}]*)\}/g, (_m, inner: string) => {
        const name = inner.trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Unsupported(`It uses the script expression \${${inner.trim().slice(0, 40)}}; only plain variables such as \${PASSWORD} are converted.`);
        let placeholder: string;
        if (USERNAME_VARS.test(name)) placeholder = "{{credentials.username}}";
        else if (PASSWORD_VARS.test(name)) placeholder = "{{credentials.password}}";
        else if (VARIABLE_NAME.test(name)) placeholder = `{{env.${name}}}`;
        else throw new Unsupported(`The variable name “${name.slice(0, 40)}” cannot be used (letters, digits and underscores, starting with a letter).`);
        ctx.variables.set(name, placeholder);
        return placeholder;
    });
}

/** Maestro matches element text as a regular expression; we match the text as typed. */
const looksLikePattern = (raw: string) => /[.*+?^()|[\]\\]/.test(raw.replace(/\$\{[^}]*\}/g, ""));

interface Target {
    locator: Locator;
}

/** A Maestro element selector (a string, or a map with `text` / `id` / `index`) → one of our locators. */
function selector(raw: unknown, ctx: Ctx, command: string, step: number): Target {
    if (typeof raw === "string" || typeof raw === "number") raw = { text: String(raw) };
    if (!isMap(raw)) throw new Unsupported("It needs an element given as text, such as “Log in”, or as an id.");
    if ("point" in raw) throw new Unsupported("Tapping a screen position cannot be converted; it names no element.");
    if (raw.optional === true) throw new Unsupported("Optional steps (they may fail without failing the flow) cannot be converted.");
    const positional = ["below", "above", "leftOf", "rightOf", "containsChild", "childOf", "containsDescendants", "traits", "enabled", "checked", "focused", "selected", "width", "height", "tolerance"].filter((k) => k in raw);
    if (positional.length) throw new Unsupported(`The selector uses “${positional[0]}”; position and state selectors cannot be converted.`);
    const text = asText(raw.text);
    const id = asText(raw.id);
    if (text === undefined && id === undefined) throw new Unsupported("It needs an element given as text, such as “Log in”, or as an id.");
    const index = typeof raw.index === "number" && Number.isInteger(raw.index) && raw.index >= 0 ? raw.index : raw.index === undefined ? undefined : -1;
    if (index === -1) throw new Unsupported("The element index must be a whole number from 0.");
    const nth = index ? { nth: index } : {};

    if (id !== undefined) {
        if (text !== undefined) ctx.notes.push({ step, command, level: "adjusted", reason: "Both text and id are given; the id is used." });
        const value = interpolate(id, ctx);
        if (ctx.kind === "web") {
            if (!/^[A-Za-z][\w-]*$/.test(value)) throw new Unsupported("A web element id must be letters, digits, dashes and underscores.");
            return { locator: { by: "css", value: `#${value}`, ...nth } };
        }
        return { locator: { by: "testId", value, ...nth } };
    }
    if (looksLikePattern(text!)) ctx.notes.push({ step, command, level: "adjusted", reason: "Maestro reads this text as a pattern; here it is matched as typed." });
    return { locator: { by: "text", value: interpolate(text!, ctx), ...nth } };
}

const direction = (v: unknown, fallback: Direction): Direction => {
    const d = asText(v)?.toLowerCase();
    if (d === undefined) return fallback;
    if ((DIRECTIONS as readonly string[]).includes(d)) return d as Direction;
    throw new Unsupported(`“${String(v).slice(0, 20)}” is not a direction (UP, DOWN, LEFT, RIGHT).`);
};

const MOBILE_KEYS: Record<string, { key: string; description: string }> = {
    enter: { key: "Enter", description: "Press Enter" },
    backspace: { key: "Backspace", description: "Press Backspace" },
    tab: { key: "Tab", description: "Press Tab" },
    back: { key: "device:back", description: "Press the Back button" },
    home: { key: "device:home", description: "Press the Home button" },
};
const WEB_KEYS: Record<string, { key: string; description: string }> = {
    enter: { key: "Enter", description: "Press Enter" },
    backspace: { key: "Backspace", description: "Press Backspace" },
    tab: { key: "Tab", description: "Press Tab" },
};

/** One command. Throws `Unsupported` when it cannot be converted; the caller turns that into a note. */
function convertCommand(name: string, arg: unknown, ctx: Ctx, step: number): void {
    const push = (s: Step) => ctx.steps.push(s);
    const mobile = ctx.kind === "mobile";
    switch (name) {
        case "launchApp": {
            // Every mobile test starts by opening the app, and a web flow opens its url: nothing to add.
            if (isMap(arg)) {
                const extras = Object.keys(arg).filter((k) => k !== "appId" && k !== "label");
                if (extras.length) ctx.notes.push({ step, command: name, level: "adjusted", reason: `The app is always started fresh from its first screen; ${extras.map((k) => `“${k}”`).join(", ")} ${extras.length === 1 ? "is" : "are"} ignored.` });
            }
            return;
        }
        case "tapOn": {
            const { locator } = selector(arg, ctx, name, step);
            ctx.lastTarget = locator;
            push({ action: "click", locator, description: "" });
            return;
        }
        case "inputText": {
            const raw = asText(arg);
            if (raw === undefined) throw new Unsupported("It needs the text to type.");
            if (!ctx.lastTarget) throw new Unsupported("It types into the field that is focused, and the importer can only tell which field when a tap on it comes just before.");
            push({ action: "fill", locator: ctx.lastTarget, value: interpolate(raw, ctx), description: "" });
            return;
        }
        case "assertVisible":
        case "assertNotVisible": {
            const { locator } = selector(arg, ctx, name, step);
            push({ action: "assert", check: name === "assertVisible" ? "visible" : "hidden", locator, description: "" });
            return;
        }
        case "scroll": {
            if (mobile) push({ action: "press", key: "device:scroll:down", description: "Scroll down" });
            else push({ action: "press", key: "PageDown", description: "Scroll down" });
            return;
        }
        case "scrollUntilVisible": {
            if (!isMap(arg) || arg.element === undefined) throw new Unsupported("It needs an element to scroll to.");
            const { locator } = selector(arg.element, ctx, name, step);
            if (arg.direction !== undefined && direction(arg.direction, "down") !== "down") ctx.notes.push({ step, command: name, level: "adjusted", reason: "The scroll direction is chosen by the test runner, not copied." });
            if (mobile) push({ action: "press", key: "device:scroll-into-view", locator, description: "Scroll until the element is on screen" });
            else {
                ctx.notes.push({ step, command: name, level: "adjusted", reason: "On the web this becomes a check that the element is on the page." });
                push({ action: "assert", check: "visible", locator, description: "" });
            }
            return;
        }
        case "back": {
            if (!mobile) throw new Unsupported("The browser’s Back button is not available in web tests yet.");
            push({ action: "press", key: "device:back", description: "Press the Back button" });
            return;
        }
        case "pressKey": {
            const raw = asText(arg)?.trim().toLowerCase();
            if (!raw) throw new Unsupported("It needs a key name.");
            const k = (mobile ? MOBILE_KEYS : WEB_KEYS)[raw];
            if (!k) throw new Unsupported(`The key “${raw.slice(0, 30)}” is not supported${mobile ? " (Enter, Backspace, Tab, Back and Home are)" : " (Enter, Backspace and Tab are)"}.`);
            push({ action: "press", key: k.key, description: k.description });
            return;
        }
        case "swipe": {
            if (!mobile) throw new Unsupported("Swiping is only converted for mobile apps.");
            if (!isMap(arg) || arg.direction === undefined) throw new Unsupported("Only swipes given as a direction (UP, DOWN, LEFT, RIGHT) are converted, not swipes between two points or from an element.");
            const extras = Object.keys(arg).filter((k) => !["direction", "duration", "label"].includes(k));
            if (extras.length) throw new Unsupported(`Only swipes given as a direction alone are converted; “${extras[0]}” is not supported.`);
            const d = direction(arg.direction, "up");
            push({ action: "press", key: `device:swipe:${d}`, description: `Swipe ${d}` });
            return;
        }
        case "waitForAnimationToEnd": {
            const t = isMap(arg) && typeof arg.timeout === "number" ? arg.timeout : 1000;
            push({ action: "wait", ms: Math.max(0, Math.min(10_000, Math.round(t))), description: "Wait for the screen to settle" });
            return;
        }
        case "runFlow": {
            if (typeof arg === "string" || (isMap(arg) && "file" in arg)) throw new Unsupported("It runs another flow file; only flows written inline (with “commands”) are converted.");
            if (!isMap(arg) || !Array.isArray(arg.commands)) throw new Unsupported("Only flows written inline (with “commands”) are converted.");
            if ("when" in arg) throw new Unsupported("A flow that runs only when a condition holds cannot be converted.");
            if (ctx.depth >= 3) throw new Unsupported("Inline flows are nested too deeply.");
            if (isMap(arg.env) && Object.keys(arg.env).length) ctx.notes.push({ step, command: name, level: "adjusted", reason: "Values given in env are not copied; define each variable on the project instead." });
            ctx.depth++;
            try {
                runCommands(arg.commands, ctx);
            } finally {
                ctx.depth--;
            }
            return;
        }
        case "repeat":
            throw new Unsupported("Repeating steps cannot be converted.");
        case "runScript":
        case "evalScript":
            throw new Unsupported("Scripts are never run by the importer.");
        case "openLink":
            throw new Unsupported("Opening a link cannot be converted.");
        default:
            throw new Unsupported("This command is not supported by the importer yet.");
    }
}

/** Walks a command list; a command is `name` or `{ name: argument }`. A command that cannot be converted is noted and skipped. */
function runCommands(list: unknown[], ctx: Ctx): void {
    for (const item of list) {
        const step = ++ctx.counter;
        let name: string;
        let arg: unknown;
        if (typeof item === "string") {
            name = item;
            arg = undefined;
        } else if (isMap(item) && Object.keys(item).length === 1) {
            name = Object.keys(item)[0]!;
            arg = item[name];
        } else {
            ctx.notes.push({ step, command: "(unknown)", level: "skipped", reason: "This entry is not a Maestro command." });
            continue;
        }
        const before = ctx.steps.length;
        try {
            convertCommand(name, arg, ctx, step);
        } catch (e) {
            if (!(e instanceof Unsupported)) throw e;
            ctx.steps.length = before;
            ctx.notes.push({ step, command: name, level: "skipped", reason: e.message });
        }
        // A tap or a typed value changes what is focused; after anything but a tap or typing, `inputText` has no known field.
        if (name !== "tapOn" && name !== "inputText" && name !== "launchApp" && name !== "waitForAnimationToEnd") ctx.lastTarget = undefined;
    }
}

const baseName = (file: string) => file.replace(/^.*[\\/]/, "");

function titleFrom(file: string, header: Record<string, unknown>): string {
    const named = asText(header.name)?.replace(/\s+/g, " ").trim();
    const base = baseName(file).replace(/\.ya?ml$/i, "").replace(/[-_]+/g, " ").trim();
    const raw = (named || base || "flow").slice(0, 120);
    const title = raw.charAt(0).toUpperCase() + raw.slice(1);
    return title.length >= 3 ? title : `Maestro flow ${title}`;
}

const skipped = (file: string, reason: string): FlowReport => ({ file, status: "skipped", reason, convertedSteps: 0, checks: 0, notes: [], variables: [] });

/** Convert one flow file. Throws `MaestroSyntaxError` only for YAML that cannot be read. */
export function convertMaestroFlow(file: MaestroFile): FlowReport {
    const name = baseName(file.name);
    if (/^config\.ya?ml$/i.test(name)) return skipped(file.name, "This is the Maestro workspace configuration, not a flow.");
    if (!/\.ya?ml$/i.test(name)) return skipped(file.name, "Only .yaml and .yml files are flows.");
    if (Buffer.byteLength(file.content, "utf8") > MAESTRO_MAX_BYTES) return skipped(file.name, `The file is larger than ${MAESTRO_MAX_BYTES / 1024} KB.`);

    // The "core" schema knows only plain YAML types: no binary, set or other special tags. A tag it does not know is reported
    // as a warning and refused below, and aliases are capped so a file cannot expand into something huge.
    const docs = parseAllDocuments(file.content, { schema: "core", uniqueKeys: true });
    const problem = docs.flatMap((d) => [...d.errors, ...d.warnings])[0];
    if (problem) throw new MaestroSyntaxError(file.name, `${baseName(file.name)}: ${problem.message.split("\n")[0]}`);
    let values: unknown[];
    try {
        values = docs.map((d) => d.toJS({ maxAliasCount: 20 }) as unknown).filter((v) => v !== null && v !== undefined);
    } catch (e) {
        throw new MaestroSyntaxError(file.name, `${baseName(file.name)}: ${e instanceof Error ? e.message.split("\n")[0] : "the file uses too many references"}`);
    }

    let header: Record<string, unknown> = {};
    let commands: unknown;
    if (values.length === 1 && Array.isArray(values[0])) commands = values[0];
    else if (values.length === 2 && isMap(values[0]) && Array.isArray(values[1])) [header, commands] = [values[0], values[1]];
    else if (values.length === 0) return skipped(file.name, "The file is empty.");
    else return skipped(file.name, "This is not a Maestro flow (a flow is a header with appId or url, then “---”, then a list of commands).");

    const appId = asText(header.appId)?.trim();
    const url = asText(header.url)?.trim();
    if (appId && url) return skipped(file.name, "The header names both an app (appId) and a web address (url); a flow tests one of them.");
    if (!appId && !url) return skipped(file.name, "The header names neither an app (appId) nor a web address (url), so it is unclear what to test.");
    if (appId && !APP_ID.test(appId)) return skipped(file.name, `“${appId.slice(0, 60)}” is not an application id such as com.example.app.`);
    if (url && !/^https?:\/\/[^\s${}]+$/i.test(url)) return skipped(file.name, "The web address must be a plain http(s) address without variables.");
    if (url) {
        try {
            new URL(url);
        } catch {
            return skipped(file.name, "The web address is not valid.");
        }
    }

    const ctx: Ctx = { kind: appId ? "mobile" : "web", steps: [], notes: [], variables: new Map(), counter: 0, depth: 0 };
    if (url) ctx.steps.push({ action: "navigate", url, description: "" });
    for (const hook of ["onFlowStart", "onFlowComplete"]) if (hook in header) ctx.notes.push({ step: 0, command: hook, level: "skipped", reason: "Flow start and end hooks are not converted." });
    if (isMap(header.env)) {
        for (const key of Object.keys(header.env)) {
            if (VARIABLE_NAME.test(key)) ctx.variables.set(key, USERNAME_VARS.test(key) ? "{{credentials.username}}" : PASSWORD_VARS.test(key) ? "{{credentials.password}}" : `{{env.${key}}}`);
        }
        if (Object.keys(header.env).length) ctx.notes.push({ step: 0, command: "env", level: "adjusted", reason: "Values given in env are not copied; define each variable on the project instead (see the list of variables)." });
    }
    runCommands(commands as unknown[], ctx);

    const checks = ctx.steps.filter((s) => s.action === "assert").length;
    const base: FlowReport = { file: file.name, status: "skipped", kind: ctx.kind, ...(appId ? { appId } : {}), ...(url ? { url } : {}), convertedSteps: ctx.steps.length - (url ? 1 : 0), checks, notes: ctx.notes, variables: [...ctx.variables].map(([n, placeholder]) => ({ name: n, placeholder })) };
    if (checks === 0) return { ...base, reason: "None of the checks in this flow could be converted, so the test would only act and never verify anything." };

    const tags = (Array.isArray(header.tags) ? header.tags : []).map(asText).filter((t): t is string => !!t && /^[A-Za-z0-9][A-Za-z0-9 _-]{0,29}$/.test(t));
    const spec: ImportedSpecInput = {
        title: titleFrom(file.name, header),
        description: `Imported from the Maestro flow ${name}.`,
        kind: ctx.kind,
        category: "Imported from Maestro",
        type: "functional",
        priority: "medium",
        steps: ctx.steps,
        tags: ["maestro", ...tags.slice(0, 8)],
        source: { origin: "imported" },
    };
    // Whatever was built must be a valid spec; if not, this is a bug in the converter, reported as a skip rather than stored.
    const check = TestSpecSchema.safeParse({ ...spec, testId: "IMP-000" });
    if (!check.success) return { ...base, reason: `The converted test is not valid: ${check.error.issues[0]?.message ?? "unknown problem"}.` };
    return { ...base, status: "converted", title: spec.title, spec };
}

export interface MaestroBatch {
    reports: FlowReport[];
    /** Files whose YAML cannot be read at all; they have no report. */
    syntaxErrors: MaestroSyntaxError[];
}

/**
 * Convert several flows. A readable-but-unusable file is reported as skipped; unreadable YAML is collected in `syntaxErrors`
 * (the caller answers 400 and lists the files). Flows that test a different app than the first one that converts are skipped,
 * because one import runs against one app.
 */
export function convertMaestroFlows(files: MaestroFile[]): MaestroBatch {
    if (files.length > MAESTRO_MAX_FLOWS) throw new RangeError(`Import at most ${MAESTRO_MAX_FLOWS} flows at a time.`);
    const reports: FlowReport[] = [];
    const syntaxErrors: MaestroSyntaxError[] = [];
    for (const f of files) {
        try {
            reports.push(convertMaestroFlow(f));
        } catch (e) {
            if (!(e instanceof MaestroSyntaxError)) throw e;
            syntaxErrors.push(e);
        }
    }
    const targetOf = (r: FlowReport) => (r.appId ? `the app ${r.appId}` : `the site ${new URL(r.url!).origin}`);
    const first = reports.find((r) => r.status === "converted");
    if (first) {
        for (const r of reports) {
            if (r.status !== "converted" || targetOf(r) === targetOf(first)) continue;
            r.status = "skipped";
            r.reason = `It tests ${targetOf(r)}, but this import is for ${targetOf(first)}. Import it in a separate batch.`;
            delete r.spec;
        }
    }
    return { reports, syntaxErrors };
}
