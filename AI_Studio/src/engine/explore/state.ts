/**
 * State fingerprints for the exploration loop (Phase 3, P3-06). Pure: no browser, no AI.
 *
 * A state is "where the browser is" at the level of detail the loop needs to notice that it is going round in circles: the address with
 * record ids replaced by `:id`, plus the page's accessibility outline reduced to roles and names. Text values (what is typed in a field,
 * paragraph text, list row text), numbers inside names ("Cart (3)") and the length of a run of identical rows are left out, so the same
 * screen with other data is the same state, and a different screen (another button, another role) is not.
 */
import { createHash } from "node:crypto";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEXISH = /^(?=.*\d)[0-9a-f]{8,}$/i;
const TOKEN = /^(?=(?:.*\d){2})(?=.*[a-z])[a-z0-9_]{8,}$/i;

function idSegment(segment: string): boolean {
    return /^\d+$/.test(segment) || UUID.test(segment) || HEXISH.test(segment) || TOKEN.test(segment);
}

function patternOfPath(path: string): string {
    const parts = path.split("/").filter((p) => p.length > 0);
    return "/" + parts.map((p) => (idSegment(p) ? ":id" : p)).join("/");
}

/** The address as a pattern: path segments that are ids become `:id`, query keys are kept (sorted) but never their values. */
export function pathPattern(url: string): string {
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        parsed = new URL(url, "http://state.invalid");
    }
    let out = patternOfPath(parsed.pathname);
    const keys = [...new Set([...parsed.searchParams.keys()])].sort();
    if (keys.length > 0) out += "?" + keys.join("&");
    // A hash route ("#/orders/77") is the app's real path in a single-page app.
    if (parsed.hash.startsWith("#/")) out = (out === "/" ? "" : out) + "/#" + patternOfPath(parsed.hash.slice(1).split("?")[0]!);
    return out;
}

// One Playwright aria snapshot line: `- role "name" [attr]: inline text`, or `- role: inline text`, or `- role "name":` (has children).
const LINE = /^(\s*)- ([a-z][a-z0-9-]*)(?: "((?:[^"\\]|\\.)*)"| \/((?:[^/\\]|\\.)*)\/)?((?: \[[^\]]*\])*)(:.*)?$/i;

interface Node {
    head: string;
    children: Node[];
}

function serialise(node: Node): string {
    return node.children.length === 0 ? node.head : `${node.head}{${collapse(node.children).join(",")}}`;
}

/** Serialised children with runs of identical siblings collapsed to one, so a list of 2 rows and one of 3 rows look alike. */
function collapse(children: Node[]): string[] {
    const out: string[] = [];
    for (const child of children) {
        const s = serialise(child);
        if (out[out.length - 1] !== s) out.push(s);
    }
    return out;
}

/**
 * The outline's shape as one string: role, name (digits replaced by `#`, spaces collapsed) and attributes per node, nested. Text nodes,
 * inline text values, property lines (`- /url: …`) and lines that are not outline lines (a truncation mark) are left out.
 */
export function outlineShape(ariaOutline: string): string {
    const root: Node = { head: "", children: [] };
    const stack: Array<{ indent: number; node: Node }> = [{ indent: -1, node: root }];
    for (const raw of ariaOutline.split(/\r?\n/)) {
        const m = LINE.exec(raw);
        if (!m) continue;
        const [, spaces, role, quoted, regex, attrs] = m;
        if (role === "text") continue;
        const name = (quoted ?? regex ?? "").replace(/\d+/g, "#").replace(/\s+/g, " ").trim();
        const node: Node = { head: `${role}${name ? `"${name}"` : ""}${(attrs ?? "").replace(/\s+/g, "")}`, children: [] };
        const indent = spaces!.length;
        while (stack.length > 1 && stack[stack.length - 1]!.indent >= indent) stack.pop();
        stack[stack.length - 1]!.node.children.push(node);
        stack.push({ indent, node });
    }
    return collapse(root.children).join(",");
}

/** `<path pattern>|<16 hex of sha256 of the outline shape>`: the path stays readable in the action log. */
export function stateFingerprint(url: string, ariaOutline: string): string {
    const hash = createHash("sha256").update(outlineShape(ariaOutline)).digest("hex").slice(0, 16);
    return `${pathPattern(url)}|${hash}`;
}
