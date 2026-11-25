/**
 * Which HTTP routes a code change reaches, on evidence only (pure; the caller passes the source files).
 *
 * A route is a literal registration in the source, never a guess from a file or function name:
 *   - `app.get("/x", …)`, `router.post(…)`, `fastify.put(…)`, `server.delete(…)` (Express, Koa router, Fastify), and receivers made
 *     by `express()`, `express.Router()`, `Router()`, `Fastify()`, `new Router()` in the same file;
 *   - `fastify.route({ method, url })`;
 *   - a route table one dispatcher reads: an object literal with a literal `method` and `path` of its own
 *     (`{ method: 'POST', path: '/api/orders', handler(ctx) {…} }`); its handler is the whole object;
 *   - Next.js `app/**\/route.ts` files: each exported GET/POST/… handler, the path from the folders;
 *   - plain `if` dispatch on the request path, as in a bare `node:http` server: `if (p === "/api/cart" && m === "POST")`, a path
 *     regular expression matched into a variable (`mm = p.match(/^\/api\/orders\/([\w-]+)$/)`, then `if (mm)`), and method or capture
 *     checks nested inside such a block (`if (m === "PUT")`, `if (mm[2] === "cancel")`).
 * Each route has the line range of its handler. A changed line inside a range reaches that route (the innermost one). A changed line
 * in a function (or, for the changed line itself, in a top-level constant that is not one: `const SHIPPING = {…}`) outside every route reaches the routes whose handlers use that function by name (in the same file, or in a file that
 * imports it by name), followed through other functions; each step is kept as evidence. Paths use `{}` for a variable segment, as the
 * test footprints do (platform/selection/coverage.ts).
 *
 * shortcut: a router's mount prefix (`app.use("/api", router)`), namespace imports (`ctl.list`), default imports and method calls on
 * objects (`this.x()`) are not followed; a change reached only that way is reported as not reaching a route. Upgrade with I2 if the PR
 * bench needs them.
 */
import { expressionEnd, innermost, isJsLike, scanJs, symbolsOf, type JsScan, type SourceSymbol } from "./diff.js";

export interface RouteEntry {
    file: string;
    /** GET, POST, …, or "*" when the registration accepts any method. */
    method: string;
    /** `/api/orders/{}` */
    path: string;
    /** The line of the registration. */
    line: number;
    /** The handler's first and last line (inclusive). */
    start: number;
    end: number;
    style: "call" | "route-object" | "next" | "if" | "table";
}

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];
const VAR = "{}";

/** `/orders/:id`, `/orders/{id}`, `/files/*` → `/orders/{}`, `/files/{}`; no trailing slash except the root. */
export function routeTemplate(path: string): string {
    const segs = path.split("/").map((s) => (/^:[A-Za-z_$]/.test(s) || /^\{[^}]*\}$/.test(s) || s === "*" || s === "(.*)" ? VAR : s));
    const out = segs.join("/").replace(/\/+$/, "");
    return out === "" ? "/" : out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// ── regular expressions of a path, as the concrete routes they allow ──────────

/** One way a path regex can match: the path template and what each capture group holds ("{}" = any text). A missing group did not take part. */
interface Variant {
    text: string;
    groups: Record<number, string>;
}
const MAX_VARIANTS = 32;

/** The routes a path regex literal allows (`/^\/api\/orders\/([\w-]+)(?:\/(pay|cancel))?$/`), or undefined when it is beyond this subset. */
export function expandPathRegex(literal: string): Variant[] | undefined {
    const m = /^\/(.*)\/[a-z]*$/s.exec(literal.trim());
    if (!m || !m[1]!.startsWith("^")) return undefined;
    let src = m[1]!.slice(1);
    if (src.endsWith("$") && !src.endsWith("\\$")) src = src.slice(0, -1);
    let i = 0;
    let group = 0;
    const cross = (a: Variant[], b: Variant[]) => a.flatMap((x) => b.map((y) => ({ text: x.text + y.text, groups: { ...x.groups, ...y.groups } })));
    const isVariableQuantifier = () => {
        const q = src[i];
        if (q === "+" || q === "*") {
            i++;
            if (src[i] === "?") i++;
            return true;
        }
        return false;
    };
    const atom = (): Variant[] | undefined => {
        const c = src[i]!;
        if (c === "(") {
            if (src.startsWith("(?", i) && !src.startsWith("(?:", i)) return undefined; // lookarounds, named groups
            const capturing = !src.startsWith("(?:", i);
            i += capturing ? 1 : 3;
            const n = capturing ? ++group : 0;
            const inner = alternatives();
            if (!inner || src[i] !== ")") return undefined;
            i++;
            let vs = inner.map((v) => (n ? { text: v.text, groups: { ...v.groups, [n]: v.text.includes(VAR) ? VAR : v.text } } : v));
            if (src[i] === "?") {
                i++;
                vs = [...vs, { text: "", groups: {} }];
            } else if (src[i] === "+" || src[i] === "*" || src[i] === "{") return undefined;
            return vs;
        }
        let variable = false;
        let literal = "";
        if (c === "[") {
            let j = i + 1;
            while (j < src.length && src[j] !== "]") j += src[j] === "\\" ? 2 : 1;
            if (j >= src.length) return undefined;
            i = j + 1;
            variable = true;
        } else if (c === "\\") {
            const d = src[i + 1];
            if (d === undefined) return undefined;
            i += 2;
            if (/[dwsDWS]/.test(d)) variable = true;
            else literal = d;
        } else if (c === ".") {
            i++;
            variable = true;
        } else if ("|)^$+*?{".includes(c)) return undefined;
        else {
            i++;
            literal = c;
        }
        if (variable) return isVariableQuantifier() ? [{ text: VAR, groups: {} }] : undefined;
        if (src[i] === "?") {
            i++;
            return [
                { text: literal, groups: {} },
                { text: "", groups: {} },
            ];
        }
        if (src[i] === "+" || src[i] === "*" || src[i] === "{") return undefined;
        return [{ text: literal, groups: {} }];
    };
    const sequence = (): Variant[] | undefined => {
        let acc: Variant[] = [{ text: "", groups: {} }];
        while (i < src.length && src[i] !== "|" && src[i] !== ")") {
            const a = atom();
            if (!a) return undefined;
            acc = cross(acc, a);
            if (acc.length > MAX_VARIANTS) return undefined;
        }
        return acc;
    };
    function alternatives(): Variant[] | undefined {
        const out: Variant[] = [];
        for (;;) {
            const s = sequence();
            if (!s) return undefined;
            out.push(...s);
            if (src[i] !== "|") return out;
            i++;
        }
    }
    const all = alternatives();
    if (!all || i !== src.length) return undefined;
    // `{}` runs (`{}{}`) collapse; a path must start with a slash.
    const vs = all.map((v) => ({ ...v, text: v.text.replace(/(?:\{\})+/g, VAR) })).filter((v) => v.text.startsWith("/"));
    return vs.length ? vs : undefined;
}

// ── finding the registrations ─────────────────────────────────────────────────

const ROUTER_NAMES = ["app", "router", "fastify", "server"];
const MADE_BY = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:new\s+)?(?:express\s*\.\s*Router|express|Router|KoaRouter|Fastify|fastify)\s*\(/g;

/** Named exports of HTTP methods in a Next.js route file give the path from its folders: `app/api/orders/[id]/route.ts` → `/api/orders/{}`. */
export function nextRoutePath(file: string): string | undefined {
    const m = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/.exec(file);
    if (!m) return undefined;
    const segs = m[1]!
        .split("/")
        .filter(Boolean)
        .filter((s) => !/^\(.*\)$/.test(s) && !s.startsWith("@")) // route groups and parallel slots are not in the address
        .map((s) => (/^\[{1,2}(?:\.\.\.)?[^\]]+\]{1,2}$/.test(s) ? VAR : s));
    return `/${segs.join("/")}`.replace(/\/$/, "") || "/";
}

function callRoutes(file: string, src: string, scan: JsScan): RouteEntry[] {
    const { code, pair, lineAt } = scan;
    const receivers = new Set(ROUTER_NAMES);
    for (const m of code.matchAll(MADE_BY)) receivers.add(m[1]!);
    const out: RouteEntry[] = [];
    for (const m of src.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|del|all|head|options)\s*\(\s*(['"`])(\/[^'"`\n]*)\3/g)) {
        if (!receivers.has(m[1]!) || code[m.index!] === " " || m[4]!.includes("${")) continue;
        const open = src.indexOf("(", m.index! + m[1]!.length);
        const close = pair[open]!;
        if (close < open) continue;
        const verb = m[2]!.toUpperCase();
        out.push({ file, method: verb === "ALL" ? "*" : verb === "DEL" ? "DELETE" : verb, path: routeTemplate(m[4]!), line: lineAt(m.index!), start: lineAt(m.index!), end: lineAt(close), style: "call" });
    }
    for (const m of code.matchAll(/\b([A-Za-z_$][\w$]*)\s*\.\s*route\s*\(\s*\{/g)) {
        if (!receivers.has(m[1]!)) continue;
        const open = m.index! + m[0].indexOf("(");
        const brace = m.index! + m[0].length - 1;
        if (pair[open]! < open || pair[brace]! < brace) continue;
        const body = src.slice(brace, pair[brace]! + 1);
        const url = /\burl\s*:\s*(['"`])(\/[^'"`\n]*)\1/.exec(body);
        if (!url || url[2]!.includes("${")) continue;
        const one = /\bmethod\s*:\s*(['"])([A-Za-z]+)\1/.exec(body);
        const many = /\bmethod\s*:\s*\[([^\]]*)\]/.exec(body);
        const methods = one ? [one[2]!.toUpperCase()] : many ? [...many[1]!.matchAll(/(['"])([A-Za-z]+)\1/g)].map((x) => x[2]!.toUpperCase()) : [];
        for (const method of methods) out.push({ file, method, path: routeTemplate(url[2]!), line: lineAt(m.index!), start: lineAt(m.index!), end: lineAt(pair[open]!), style: "route-object" });
    }
    return out;
}

/** The `{` of the object literal around an offset (code view: strings and comments do not count), if any. */
function enclosingBrace(code: string, at: number): number | undefined {
    let depth = 0;
    for (let k = at - 1; k >= 0; k--) {
        const ch = code[k];
        if (ch === "}") depth++;
        else if (ch === "{") {
            if (depth === 0) return k;
            depth--;
        }
    }
    return undefined;
}

/** Route tables: `{ method: 'GET', path: '/api/cart/items', handler: … }`, both literal properties of the same object. */
function tableRoutes(file: string, src: string, scan: JsScan): RouteEntry[] {
    const { code, pair, lineAt } = scan;
    const out: RouteEntry[] = [];
    for (const m of src.matchAll(/\bmethod\s*:\s*(['"])(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\1/gi)) {
        if (code[m.index!] === " ") continue;
        const open = enclosingBrace(code, m.index!);
        if (open === undefined || !(pair[open]! > open)) continue;
        let path: string | undefined;
        for (const p of src.slice(open, pair[open]! + 1).matchAll(/\bpath\s*:\s*(['"`])(\/[^'"`\n]*)\1/g)) {
            const at = open + p.index!;
            if (code[at] !== " " && enclosingBrace(code, at) === open && !p[2]!.includes("${")) {
                path = p[2];
                break;
            }
        }
        if (path) out.push({ file, method: m[2]!.toUpperCase(), path: routeTemplate(path), line: lineAt(m.index!), start: lineAt(open), end: lineAt(pair[open]!), style: "table" });
    }
    return out;
}

function nextRoutes(file: string, symbols: SourceSymbol[]): RouteEntry[] {
    const path = nextRoutePath(file);
    if (!path) return [];
    return symbols.filter((s) => s.exported && METHODS.includes(s.name)).map((s) => ({ file, method: s.name, path, line: s.start, start: s.start, end: s.end, style: "next" as const }));
}

interface Condition {
    paths: string[];
    methods: string[];
    matchVar?: string;
    /** Capture group n: a literal it equals, "set" or "unset". */
    groups: Record<number, string | { set: boolean }>;
}

/** Splits `text` at top-level `&&` (positions from the code view, so strings cannot fool it). */
function conjuncts(text: string, code: string): string[] {
    const out: string[] = [];
    let depth = 0;
    let from = 0;
    for (let k = 0; k < code.length; k++) {
        const ch = code[k]!;
        if (ch === "(" || ch === "[" || ch === "{") depth++;
        else if (ch === ")" || ch === "]" || ch === "}") depth--;
        else if (depth === 0 && ch === "&" && code[k + 1] === "&") {
            out.push(text.slice(from, k));
            from = k + 2;
            k++;
        }
    }
    out.push(text.slice(from));
    return out.map((s) => s.trim()).filter(Boolean);
}

function ifRoutes(file: string, src: string, scan: JsScan): RouteEntry[] {
    const { code, pair, lineAt } = scan;
    const pathExprs = new Set(["url.pathname", "req.url", "request.url", "req.path"]);
    const methodExprs = new Set(["req.method", "request.method"]);
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[A-Za-z_$][\w$.]*\.pathname|(?:req|request)\.(?:url|path))\b/g)) pathExprs.add(m[1]!);
    // One brace pair without nesting, then a look inside: two `[^}]*` around the word backtracked cubically on a file without a `}`.
    if ([...code.matchAll(/\b(?:const|let|var)\s*\{([^{}]*)\}\s*=/g)].some((m) => /\bpathname\b/.test(m[1]!))) pathExprs.add("pathname");
    for (const m of code.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:req|request)\.method\b/g)) methodExprs.add(m[1]!);
    const pathAlt = [...pathExprs].map(escapeRe).join("|");
    const methodAlt = [...methodExprs].map(escapeRe).join("|");

    // mm = p.match(/…/): each assignment, in order, with the routes its regex allows.
    const matches: Array<{ name: string; at: number; variants: Variant[] | undefined }> = [];
    for (const m of code.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*(?:${pathAlt})\\s*\\.\\s*match\\s*\\(`, "g"))) {
        const open = m.index! + m[0].length - 1;
        if (pair[open]! < open) continue;
        matches.push({ name: m[1]!, at: m.index!, variants: expandPathRegex(src.slice(open + 1, pair[open]!)) });
    }
    const matchNames = new Set(matches.map((x) => x.name));

    const read = (text: string, codeText: string): Condition => {
        const c: Condition = { paths: [], methods: [], groups: {} };
        conjuncts(text, codeText).forEach((part) => {
            if (part.startsWith("!") && !/^!\s*[A-Za-z_$][\w$]*\[\d+\]$/.test(part)) return; // a negated test says what the route is not
            for (const m of part.matchAll(new RegExp(`(?<![\\w$.])(?:${pathAlt})\\s*===?\\s*(['"\`])(\\/[^'"\`]*)\\1`, "g"))) c.paths.push(m[2]!);
            for (const m of part.matchAll(new RegExp(`(?<![\\w$.])(?:${methodAlt})\\s*===?\\s*(['"])([A-Za-z]+)\\1`, "g"))) c.methods.push(m[2]!.toUpperCase());
            const bare = /^\(?\s*([A-Za-z_$][\w$]*)\s*\)?$/.exec(part);
            if (bare && matchNames.has(bare[1]!)) c.matchVar = bare[1];
            const g = /^(!?)\s*([A-Za-z_$][\w$]*)\[(\d+)\](?:\s*===?\s*(['"])([^'"]*)\4)?$/.exec(part);
            if (g && matchNames.has(g[2]!)) {
                c.matchVar ??= g[2];
                c.groups[Number(g[3])] = g[5] !== undefined ? g[5] : { set: g[1] !== "!" };
            }
        });
        return c;
    };
    const keep = (v: Variant, groups: Condition["groups"]) =>
        Object.entries(groups).every(([n, want]) => {
            const got = v.groups[Number(n)];
            if (typeof want === "string") return got === want || got === VAR;
            return want.set ? got !== undefined : got === undefined;
        });

    interface Block {
        start: number;
        end: number;
        method: string;
        variants: Variant[];
    }
    const blocks: Block[] = [];
    const out: RouteEntry[] = [];
    for (const m of code.matchAll(/\bif\s*\(/g)) {
        const open = m.index! + m[0].length - 1;
        const close = pair[open]!;
        if (close < open) continue;
        let k = close + 1;
        while (k < code.length && /\s/.test(code[k]!)) k++;
        const end = code[k] === "{" && pair[k]! > k ? pair[k]! : expressionEnd(scan, k);
        const cond = read(src.slice(open + 1, close), code.slice(open + 1, close));
        const parent = innermost(blocks, open);
        let variants: Variant[] | undefined;
        if (cond.paths.length) variants = cond.paths.map((p) => ({ text: p, groups: {} }));
        else if (cond.matchVar && !parent) {
            const assigned = matches.filter((x) => x.name === cond.matchVar && x.at < m.index!).at(-1);
            variants = assigned?.variants?.filter((v) => keep(v, cond.groups));
        } else if (parent && (cond.methods.length || Object.keys(cond.groups).length)) variants = parent.variants.filter((v) => keep(v, cond.groups));
        if (!variants?.length) continue;
        const methods = cond.methods.length ? [...new Set(cond.methods)] : [parent && !cond.paths.length ? parent.method : "*"];
        const block = { start: open, end, method: methods.length === 1 ? methods[0]! : "*", variants };
        blocks.push(block);
        const seen = new Set<string>();
        for (const method of methods)
            for (const v of variants) {
                const path = routeTemplate(v.text);
                if (seen.has(`${method} ${path}`)) continue;
                seen.add(`${method} ${path}`);
                out.push({ file, method, path, line: lineAt(m.index!), start: lineAt(m.index!), end: lineAt(end), style: "if" });
            }
    }
    return out;
}

/** Every literal route registration in one file, with its handler's lines. A file that registers none gives []. */
export function routesOf(file: string, source: string): RouteEntry[] {
    if (!isJsLike(file)) return [];
    const scan = scanJs(source);
    return [...callRoutes(file, source, scan), ...tableRoutes(file, source, scan), ...nextRoutes(file, symbolsOf(file, source, scan)), ...ifRoutes(file, source, scan)];
}

// ── from changed lines to routes ──────────────────────────────────────────────

export interface RouteHit {
    route: RouteEntry;
    /** How the change gets there, step by step, each with its file and line. */
    evidence: string[];
}

export interface ChangeRoutes {
    hits: RouteHit[];
    /** Changed code that reaches no route, with the reason (each with file:line). */
    unresolved: string[];
}

export const describeRoute = (r: RouteEntry) => `${r.method === "*" ? "ANY" : r.method} ${r.path} (${r.file}:${r.line})`;

interface FileIndex {
    src: string;
    scan: JsScan;
    symbols: SourceSymbol[];
    routes: RouteEntry[];
    /** Local name → { from: resolved file, name: exported name }. */
    imports: Map<string, { from: string; name: string }>;
    importSpans: Array<[number, number]>;
}

const norm = (p: string) => p.replace(/\\/g, "/").replace(/^\.\//, "");
function resolveSpec(fromFile: string, spec: string, files: Set<string>): string | undefined {
    if (!spec.startsWith(".")) return undefined;
    const parts = fromFile.split("/").slice(0, -1);
    for (const seg of spec.split("/")) {
        if (seg === "..") parts.pop();
        else if (seg !== ".") parts.push(seg);
    }
    const base = parts.join("/");
    const stem = base.replace(/\.[cm]?[jt]sx?$/, "");
    const exts = [".ts", ".tsx", ".js", ".mjs", ".cjs", ".jsx", ".mts", ".cts"];
    return [base, ...exts.map((e) => stem + e), ...exts.map((e) => `${base}/index${e}`)].find((c) => files.has(c));
}

/** Which routes the changed lines of one file reach, through the other files given (path → source). */
export function routesForChange(sources: Record<string, string>, file: string, lines: number[]): ChangeRoutes {
    const files = new Map(Object.entries(sources).map(([k, v]) => [norm(k), v]));
    const names = new Set(files.keys());
    const cache = new Map<string, FileIndex | undefined>();
    const index = (f: string): FileIndex | undefined => {
        if (cache.has(f)) return cache.get(f);
        const src = files.get(f);
        let ix: FileIndex | undefined;
        if (src !== undefined && isJsLike(f)) {
            const scan = scanJs(src);
            const imports = new Map<string, { from: string; name: string }>();
            const importSpans: Array<[number, number]> = [];
            const re = /\bimport\s+(?:type\s+)?(?:[\w$]+\s*,\s*)?\{([^}]*)\}\s*from\s*(['"])([^'"]+)\2|\b(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\s*\(\s*(['"])([^'"]+)\5\s*\)/g;
            for (const m of src.matchAll(re)) {
                if (scan.code[m.index!] === " ") continue;
                importSpans.push([m.index!, m.index! + m[0].length]);
                const from = resolveSpec(f, m[3] ?? m[6]!, names);
                if (!from) continue;
                for (const spec of (m[1] ?? m[4]!).split(",")) {
                    const s = spec.trim().replace(/^type\s+/, "");
                    const two = /^([\w$]+)\s*(?:as|:)\s*([\w$]+)$/.exec(s);
                    if (two) imports.set(two[2]!, { from, name: two[1]! });
                    else if (/^[\w$]+$/.test(s)) imports.set(s, { from, name: s });
                }
            }
            const symbols = symbolsOf(f, src, scan);
            ix = { src, scan, symbols, routes: routesOf(f, src), imports, importSpans };
        }
        cache.set(f, ix);
        return ix;
    };
    /** The top-level constant (not a function) whose statement holds the line: the last one that starts before it and reaches it. */
    const constantAt = (ix: FileIndex, line: number): SourceSymbol | undefined => {
        let found: SourceSymbol | undefined;
        const code = ix.scan.code;
        let depth = 0;
        let k = 0;
        for (const m of code.matchAll(/(?<![\w$.])(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/g)) {
            const start = ix.scan.lineAt(m.index!);
            if (start > line) break;
            // Only at the top of the file: a local `const user = …` inside a callback is another name in every handler.
            for (; k < m.index!; k++) depth += "([{".includes(code[k]!) ? 1 : ")]}".includes(code[k]!) ? -1 : 0;
            if (depth !== 0 || innermost(ix.symbols, start)) continue;
            const end = ix.scan.lineAt(expressionEnd(ix.scan, m.index! + m[0].length));
            if (line <= end) found = { name: m[1]!, kind: "constant", start, end, at: m.index! + m[0].indexOf(m[1]!, m[0].search(/\s/)) };
        }
        return found;
    };
    const routesAt = (ix: FileIndex, line: number): RouteEntry[] => {
        const best = innermost(ix.routes, line);
        return best ? ix.routes.filter((r) => r.start === best.start && r.end === best.end) : [];
    };
    /** Every use of `name` in file f: not a property (`.name`), not inside an import, not at `skip`. */
    const usesOf = (f: string, name: string, skip?: SourceSymbol): Array<{ line: number }> => {
        const ix = index(f);
        if (!ix) return [];
        const out: Array<{ line: number }> = [];
        for (const m of ix.scan.code.matchAll(new RegExp(`(?<![\\w$.])${escapeRe(name)}(?![\\w$])`, "g"))) {
            const at = m.index!;
            if (skip && (at === skip.at || (ix.scan.lineAt(at) >= skip.start && ix.scan.lineAt(at) <= skip.end))) continue;
            if (ix.symbols.some((s) => s.at === at)) continue; // another declaration of the same name
            if (ix.importSpans.some(([a, b]) => at >= a && at < b)) continue;
            out.push({ line: ix.scan.lineAt(at) });
        }
        return out;
    };

    const target = norm(file);
    const hits = new Map<string, RouteHit>();
    const unresolved: string[] = [];
    const hit = (route: RouteEntry, evidence: string[]) => {
        const key = `${route.file}:${route.line}:${route.method}:${route.path}`;
        if (!hits.has(key)) hits.set(key, { route, evidence });
    };
    const ix = index(target);
    if (!ix) return { hits: [], unresolved: lines.length ? [`${target}: not a JavaScript or TypeScript file given here, so its routes are not known.`] : [] };

    // Breadth first, so each route keeps its shortest chain of evidence.
    const queue: Array<{ f: string; sym: SourceSymbol; chain: string[] }> = [];
    const queued = new Set<string>();
    const enqueue = (f: string, sym: SourceSymbol, chain: string[]) => {
        const key = `${f}:${sym.name}:${sym.start}`;
        if (queued.has(key)) return;
        queued.add(key);
        queue.push({ f, sym, chain });
    };
    for (const line of [...new Set(lines)].sort((a, b) => a - b)) {
        const direct = routesAt(ix, line);
        if (direct.length) {
            for (const r of direct) hit(r, [`${target}:${line} is inside the handler of ${describeRoute(r)}`]);
            continue;
        }
        const sym = innermost(ix.symbols, line) ?? constantAt(ix, line);
        if (!sym) unresolved.push(`${target}:${line} is outside every route handler and every function.`);
        else enqueue(target, sym, [`${target}:${line} is in ${sym.name}${sym.kind === "constant" ? "" : "()"} (${target}:${sym.start}-${sym.end})`]);
    }
    for (let q = 0; q < queue.length && q < 500; q++) {
        const { f, sym, chain } = queue[q]!;
        const where: Array<{ f: string; name: string; skip?: SourceSymbol }> = [{ f, name: sym.name, skip: sym }];
        for (const other of names) {
            if (other === f) continue;
            const oi = index(other);
            if (!oi) continue;
            for (const [local, imp] of oi.imports) if (imp.from === f && imp.name === sym.name) where.push({ f: other, name: local });
        }
        let used = 0;
        for (const w of where) {
            const wi = index(w.f)!;
            for (const u of usesOf(w.f, w.name, w.skip)) {
                used++;
                const step = `${sym.name} is used at ${w.f}:${u.line}`;
                const routes = routesAt(wi, u.line);
                if (routes.length) {
                    for (const r of routes) hit(r, [...chain, `${step}, inside the handler of ${describeRoute(r)}`]);
                    continue;
                }
                const outer = innermost(
                    wi.symbols.filter((s) => !(w.f === f && s.name === sym.name && s.start === sym.start)),
                    u.line,
                );
                if (outer && chain.length < 8) enqueue(w.f, outer, [...chain, `${step}, in ${outer.name}() (${w.f}:${outer.start}-${outer.end})`]);
                else unresolved.push(`${[...chain, step].join("; ")}, outside every route handler.`);
            }
        }
        if (!used) unresolved.push(`${chain.join("; ")}; ${sym.name} is not used in any file given.`);
    }
    return { hits: [...hits.values()], unresolved };
}
