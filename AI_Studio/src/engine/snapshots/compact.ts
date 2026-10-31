/**
 * Smaller page snapshots for the web authoring agent (docs/features/smaller-snapshots.md).
 *
 * The agent reads the page as Playwright's accessibility snapshot (YAML lines like `- button "Log in"`) after every action, and every
 * earlier snapshot stays in the conversation, so snapshot text is most of what a run sends. This module makes it smaller without
 * changing anything the model copies into a test:
 *
 *  - compactSnapshot(): drops what nobody can act on or read (unnamed images, separators, text that is only punctuation), puts a
 *    link's address on the link's own line, shortens long text, and collapses runs of siblings that look alike (a list of 40
 *    product cards becomes the first 3 in full plus one line naming the other 37 in order). Lines that stay are copied verbatim:
 *    a role and an accessible name are never rewritten, and every collapsed actionable element is still named with its exact
 *    `role "name"`. Hidden and aria-hidden elements are already absent from Playwright's snapshot.
 *  - diffSnapshots(): after the first snapshot of a page, only what changed (added, removed, changed lines, each under the path of
 *    its parents) plus a one-line summary of the page.
 *  - SnapshotView: one authoring session's choice between the two, the "look at the whole page" escape hatch, and the counts that
 *    show what was saved.
 *
 * Pure text in, text out: no browser, no model, so every rule is covered by fast unit tests on recorded real snapshots.
 */
import type { EngineEvent } from "../context.js";
import { CHARS_PER_TOKEN } from "../llm/usage.js";
import { EVENT_SNAPSHOT_SAVINGS } from "./setting.js";

// ── the tree ────────────────────────────────────────────────────────────────

export interface SnapNode {
    /** The key exactly as printed (may be YAML-quoted), with an inlined address appended as ` [url=…]`. */
    head: string;
    /** The ARIA role ("button"), "text" for static text, or a property name ("/url"). */
    role: string;
    /** The accessible name as printed, with its double quotes (`"Log in"`), or undefined. */
    name?: string;
    /** The value after `: ` exactly as printed, or undefined. */
    value?: string;
    children: SnapNode[];
}

/** Roles a test acts on: these keep their exact `role "name"` in every view the model gets. */
export const ACTIONABLE_ROLES = new Set([
    "button", "link", "textbox", "searchbox", "checkbox", "radio", "combobox", "listbox", "option", "menuitem", "menuitemcheckbox",
    "menuitemradio", "tab", "switch", "slider", "spinbutton", "treeitem",
]);

/** Shortening and collapsing limits. */
export const RULES = {
    /** A text value longer than this is shortened … */
    longText: 200,
    /** … to this many characters, followed by how many were left out. */
    keepText: 160,
    /** Siblings that look alike are collapsed from this many in a row … */
    collapseFrom: 6,
    /** … keeping this many in full. */
    keepInRun: 3,
    /** A collapse must save at least this share of the run's characters, or the run is left as it is. */
    minRunSaving: 0.3,
    /** Characters of names listed for the collapsed items before the line says "and N more". */
    namesBudget: 2000,
} as const;

const PUNCTUATION_ONLY = /^[\s|·•‧∙\-–—/\\,.:;*_~]*$/u;

/** Split `- key: value` content into its key and value, honouring YAML quoting (a name may contain ": "). */
function splitKey(content: string): { key: string; rest: string } {
    const q = content[0];
    if (q === "'" || q === '"') {
        for (let i = 1; i < content.length; i++) {
            const c = content[i];
            if (q === '"' && c === "\\") {
                i++;
                continue;
            }
            if (c === q) {
                if (q === "'" && content[i + 1] === "'") {
                    i++;
                    continue;
                }
                return { key: content.slice(0, i + 1), rest: content.slice(i + 1) };
            }
        }
        return { key: content, rest: "" };
    }
    let inQuote = false;
    for (let i = 0; i < content.length; i++) {
        const c = content[i];
        if (inQuote && c === "\\") {
            i++;
            continue;
        }
        if (c === '"') inQuote = !inQuote;
        else if (c === ":" && !inQuote && (i === content.length - 1 || content[i + 1] === " ")) return { key: content.slice(0, i), rest: content.slice(i) };
    }
    return { key: content, rest: "" };
}

/** Role and quoted name of a key; a single-quoted YAML key is read through its quoting, the printed key itself is never changed. */
function roleAndName(key: string): { role: string; name?: string } {
    const inner = key.startsWith("'") && key.endsWith("'") && key.length >= 2 ? key.slice(1, -1).replace(/''/g, "'") : key;
    const role = /^([^\s"[\]:]+)/.exec(inner)?.[1] ?? inner;
    const name = /"(?:[^"\\]|\\.)*"/.exec(inner.slice(role.length))?.[0];
    return name === undefined ? { role } : { role, name };
}

/** Parse Playwright's YAML-like snapshot into a tree. Lines that are not `- …` items (rare continuations) stay with the item above. */
export function parseSnapshot(yaml: string): SnapNode[] {
    const roots: SnapNode[] = [];
    const stack: Array<{ indent: number; node: SnapNode }> = [];
    for (const rawLine of yaml.replace(/\r\n/g, "\n").split("\n")) {
        if (!rawLine.trim()) continue;
        const indent = rawLine.length - rawLine.trimStart().length;
        const trimmed = rawLine.trimStart();
        if (!trimmed.startsWith("- ")) {
            const last = stack[stack.length - 1]?.node;
            if (last) last.value = last.value === undefined ? trimmed : `${last.value} ${trimmed}`;
            else roots.push({ head: trimmed, role: "text", children: [] });
            continue;
        }
        const { key, rest } = splitKey(trimmed.slice(2));
        const node: SnapNode = { head: key, ...roleAndName(key), children: [] };
        if (rest.startsWith(": ")) node.value = rest.slice(2);
        while (stack.length && stack[stack.length - 1]!.indent >= indent) stack.pop();
        const parent = stack[stack.length - 1]?.node;
        (parent ? parent.children : roots).push(node);
        stack.push({ indent, node });
    }
    return roots;
}

export function renderSnapshot(nodes: readonly SnapNode[], depth = 0): string {
    const out: string[] = [];
    const walk = (list: readonly SnapNode[], d: number) => {
        for (const n of list) {
            out.push(lineOf(n, d));
            walk(n.children, d + 1);
        }
    };
    walk(nodes, depth);
    return out.join("\n");
}

function lineOf(n: SnapNode, depth: number): string {
    const pad = "  ".repeat(depth);
    if (n.value !== undefined) return `${pad}- ${n.head}: ${n.value}`;
    return `${pad}- ${n.head}${n.children.length ? ":" : ""}`;
}

// ── compaction ──────────────────────────────────────────────────────────────

/** The text of a printed value without its YAML quoting. */
function plainValue(v: string): string {
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) {
        try {
            return JSON.parse(v) as string;
        } catch {
            return v.slice(1, -1);
        }
    }
    if (v.startsWith("'") && v.endsWith("'") && v.length >= 2) return v.slice(1, -1).replace(/''/g, "'");
    return v;
}

function shorten(v: string): string {
    const text = plainValue(v);
    if (text.length <= RULES.longText) return v;
    const cut = text.slice(0, RULES.keepText).replace(/\s+\S*$/, "");
    return JSON.stringify(`${cut}… (${text.length - cut.length} more characters)`);
}

function isDecorative(n: SnapNode): boolean {
    if (n.children.length) return false;
    if ((n.role === "img" || n.role === "image" || n.role === "separator") && n.name === undefined && n.value === undefined) return true;
    if (n.role === "text" && n.value !== undefined && PUNCTUATION_ONLY.test(plainValue(n.value))) return true;
    return false;
}

/** Rules that look at one node: drop decorations, unwrap layout-only wrappers, inline the address, shorten long text. */
function tidy(list: readonly SnapNode[]): SnapNode[] {
    const out: SnapNode[] = [];
    for (const src of list) {
        const n: SnapNode = { ...src, children: tidy(src.children) };
        if ((n.role === "generic" || n.role === "none" || n.role === "presentation") && n.name === undefined && n.value === undefined) {
            out.push(...n.children);
            continue;
        }
        if (isDecorative(n)) continue;
        const url = n.children.findIndex((c) => c.role === "/url" && c.value !== undefined && !c.children.length);
        if (url >= 0 && n.role !== "text") {
            n.head = `${n.head} [url=${n.children[url]!.value}]`;
            n.children = n.children.filter((_, i) => i !== url);
        }
        if (n.value !== undefined && !n.role.startsWith("/")) n.value = shorten(n.value);
        out.push(n);
    }
    return out;
}

/** What a node looks like, ignoring names, text and states: siblings with the same signature are "like each other". */
function signature(n: SnapNode): string {
    const kids = n.children.filter((c) => !c.role.startsWith("/"));
    return `${n.role}${n.name !== undefined ? "*" : ""}${kids.length ? `(${kids.map(signature).join(",")})` : ""}`;
}

function* walk(n: SnapNode): Generator<SnapNode> {
    yield n;
    for (const c of n.children) yield* walk(c);
}

const tokenOf = (n: SnapNode) => `${n.role} ${n.name}`;

/** The pattern every collapsed item shares: its structure, naming the elements that are the same in all of them. */
function patternOf(first: SnapNode, shared: ReadonlySet<string>): string {
    const one = (n: SnapNode): string => {
        const kids = n.children.filter((c) => !c.role.startsWith("/"));
        const own = n.name !== undefined && shared.has(tokenOf(n)) ? tokenOf(n) : n.role;
        return kids.length ? `${own} [${kids.map(one).join(", ")}]` : own;
    };
    const kids = first.children.filter((c) => !c.role.startsWith("/"));
    const text = kids.map(one).join(", ");
    return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/** How one collapsed item is told apart from the others: its actionable elements by exact `role "name"`, then what else names it. */
function labelOf(item: SnapNode, shared: ReadonlySet<string>): string {
    const nodes = [...walk(item)];
    const printed: string[] = [];
    const names: string[] = [];
    // In page order. Actionable elements always; any other named element only when it adds a name not already said
    // (a heading that only repeats its link's name, or cells already in their row's name, are left out).
    const actionableNames = new Set(nodes.filter((n) => n.name !== undefined && ACTIONABLE_ROLES.has(n.role)).map((n) => plainValue(n.name!)));
    for (const n of nodes) {
        if (n.name === undefined || shared.has(tokenOf(n))) continue;
        const t = tokenOf(n);
        const plain = plainValue(n.name);
        if (!ACTIONABLE_ROLES.has(n.role) && (!plain || actionableNames.has(plain) || names.some((x) => x.includes(plain)))) continue;
        if (printed.includes(t)) continue;
        printed.push(t);
        names.push(plain);
    }
    const leaf = nodes.find((n) => n.value !== undefined && !n.role.startsWith("/") && n.children.length === 0 && !names.some((x) => x.includes(plainValue(n.value!))));
    if (leaf) {
        const v = plainValue(leaf.value!);
        printed.push(v.length > 40 ? `${v.slice(0, 39)}…` : v);
    }
    return printed.join(", ");
}

/** Collapse runs of alike siblings, at every level. */
function collapse(list: readonly SnapNode[]): SnapNode[] {
    const out: SnapNode[] = [];
    let i = 0;
    while (i < list.length) {
        const sig = signature(list[i]!);
        let j = i + 1;
        while (j < list.length && signature(list[j]!) === sig) j++;
        const run = list.slice(i, j);
        const folded = run.length >= RULES.collapseFrom ? foldRun(run) : undefined;
        if (folded) out.push(...folded);
        else out.push(...run.map((n) => ({ ...n, children: collapse(n.children) })));
        i = j;
    }
    return out;
}

function foldRun(run: readonly SnapNode[]): SnapNode[] | undefined {
    const tokenSets = run.map((item) => new Set([...walk(item)].filter((n) => n.name !== undefined).map(tokenOf)));
    const shared = new Set([...tokenSets[0]!].filter((t) => tokenSets.every((s) => s.has(t))));
    const kept = run.slice(0, RULES.keepInRun).map((n) => ({ ...n, children: collapse(n.children) }));
    const hidden = run.slice(RULES.keepInRun);
    const role = run[0]!.role;
    const labels: string[] = [];
    let used = 0;
    let listed = 0;
    for (const item of hidden) {
        const l = labelOf(item, shared);
        if (!l) continue;
        if (used + l.length > RULES.namesBudget) break;
        labels.push(l);
        used += l.length + 2;
        listed++;
    }
    const withLabels = hidden.filter((h) => labelOf(h, shared)).length;
    const pattern = patternOf(run[0]!, shared);
    let text = `(${hidden.length} more ${role} like the ${kept.length} above${pattern ? `, each: ${pattern}` : ""}`;
    if (labels.length) text += `. In order: ${labels.join("; ")}`;
    if (listed < withLabels) text += `; and ${withLabels - listed} more, see the whole page`;
    text += ")";
    const before = renderSnapshot(hidden).length;
    if (text.length > before * (1 - RULES.minRunSaving)) return undefined;
    return [...kept, { head: text, role: "(collapsed)", children: [] }];
}

export interface CompactStats {
    rawChars: number;
    compactChars: number;
    dropped: number;
    collapsedRuns: number;
    collapsedItems: number;
    shortenedTexts: number;
}

/** The compact form of one snapshot (text, the tree it was rendered from, and what changed). */
export function compactSnapshot(yaml: string): { text: string; tree: SnapNode[]; stats: CompactStats } {
    const raw = parseSnapshot(yaml);
    const tree = collapse(tidy(raw));
    const text = renderSnapshot(tree);
    const count = (list: readonly SnapNode[]) => list.reduce((a, n) => a + [...walk(n)].length, 0);
    const runs = tree.reduce((a, n) => a + [...walk(n)].filter((x) => x.role === "(collapsed)").length, 0);
    const items = tree.reduce((a, n) => a + [...walk(n)].filter((x) => x.role === "(collapsed)").reduce((b, x) => b + Number(/^\((\d+) more/.exec(x.head)?.[1] ?? 0), 0), 0);
    const shortened = (text.match(/… \(\d+ more characters\)/g) ?? []).length;
    return { text, tree, stats: { rawChars: yaml.length, compactChars: text.length, dropped: Math.max(0, count(raw) - count(tree)), collapsedRuns: runs, collapsedItems: items, shortenedTexts: shortened } };
}

/** Every `role "name"` of an actionable element in a snapshot (for the checks that nothing the model acts on went missing). */
export function actionableNames(yaml: string): string[] {
    const out: string[] = [];
    for (const root of parseSnapshot(yaml)) for (const n of walk(root)) if (n.name !== undefined && ACTIONABLE_ROLES.has(n.role)) out.push(`${n.role} ${n.name}`);
    return out;
}

// ── what changed ────────────────────────────────────────────────────────────

interface Flat {
    depth: number;
    line: string;
    /** The parents' keys, outermost first, with a position for unnamed repeats ("article #7"). */
    path: string[];
    head: string;
}

function flatten(tree: readonly SnapNode[]): Flat[] {
    const out: Flat[] = [];
    const go = (list: readonly SnapNode[], depth: number, path: string[]) => {
        const labelOfNode = (n: SnapNode) => (n.name !== undefined ? `${n.role} ${n.name}` : n.role);
        const total = new Map<string, number>();
        for (const n of list) total.set(labelOfNode(n), (total.get(labelOfNode(n)) ?? 0) + 1);
        const seen = new Map<string, number>();
        for (const n of list) {
            const label = labelOfNode(n);
            const k = (seen.get(label) ?? 0) + 1;
            seen.set(label, k);
            out.push({ depth, line: lineOf(n, 0).slice(2), path, head: n.head });
            go(n.children, depth + 1, [...path, (total.get(label) ?? 0) > 1 ? `${label} #${k}` : label]);
        }
    };
    go(tree, 0, []);
    return out;
}

/** Above this many lines on either side a diff is not attempted (the full compact snapshot is sent). */
const MAX_DIFF_LINES = 2500;

type Op = { kind: "same" | "add" | "del"; a?: Flat; b?: Flat };

function editScript(a: Flat[], b: Flat[]): Op[] | undefined {
    if (a.length > MAX_DIFF_LINES || b.length > MAX_DIFF_LINES) return undefined;
    const key = (f: Flat) => `${f.depth}|${f.line}`;
    const ka = a.map(key);
    const kb = b.map(key);
    const n = a.length;
    const m = b.length;
    // Longest common subsequence, table of suffix lengths.
    const w = m + 1;
    const t = new Uint32Array((n + 1) * w);
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) t[i * w + j] = ka[i] === kb[j] ? t[(i + 1) * w + j + 1]! + 1 : Math.max(t[(i + 1) * w + j]!, t[i * w + j + 1]!);
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        if (ka[i] === kb[j]) ops.push({ kind: "same", a: a[i++], b: b[j++] });
        else if (t[(i + 1) * w + j]! >= t[i * w + j + 1]!) ops.push({ kind: "del", a: a[i++] });
        else ops.push({ kind: "add", b: b[j++] });
    }
    while (i < n) ops.push({ kind: "del", a: a[i++] });
    while (j < m) ops.push({ kind: "add", b: b[j++] });
    return ops;
}

/** One line on the page: where it is and what it offers. */
export function pageSummary(url: string, tree: readonly SnapNode[]): string {
    let heading: string | undefined;
    let controls = 0;
    for (const root of tree)
        for (const n of walk(root)) {
            if (!heading && n.role === "heading" && n.name !== undefined) heading = n.name;
            if (ACTIONABLE_ROLES.has(n.role)) controls++;
        }
    let where = url;
    try {
        const u = new URL(url);
        where = u.pathname + u.search;
    } catch {
        /* keep as given */
    }
    return `Same page (${where}${heading ? `, heading ${heading}` : ""}, ${controls} ${controls === 1 ? "control" : "controls"})`;
}

/**
 * What changed between two compact trees, as plain lines under the path of their parents. Undefined when nothing can be said
 * more briefly than the whole snapshot (too large to compare).
 */
export function diffSnapshots(before: readonly SnapNode[], after: readonly SnapNode[]): { text: string; changes: number } | undefined {
    const ops = editScript(flatten(before), flatten(after));
    if (!ops) return undefined;
    const hunks: Op[][] = [];
    let cur: Op[] = [];
    for (const op of ops) {
        if (op.kind === "same") {
            if (cur.length) hunks.push(cur);
            cur = [];
        } else cur.push(op);
    }
    if (cur.length) hunks.push(cur);
    if (!hunks.length) return { text: "", changes: 0 };
    const lines: string[] = [];
    let changes = 0;
    for (const h of hunks) {
        const dels = h.filter((o) => o.kind === "del").map((o) => o.a!);
        const adds = h.filter((o) => o.kind === "add").map((o) => o.b!);
        const anchor = (adds[0] ?? dels[0])!;
        const base = anchor.depth;
        lines.push(`At ${anchor.path.length ? anchor.path.join(" > ") : "the top of the page"}:`);
        const rel = (f: Flat) => `${"  ".repeat(Math.max(0, f.depth - base) + 2)}- ${f.line}`;
        // Same element, new text or state: one "changed" line instead of a removal and an addition.
        if (dels.length === adds.length && dels.every((d, k) => d.head.replace(/ \[[^\]]*\]$/, "") === adds[k]!.head.replace(/ \[[^\]]*\]$/, "") && d.depth === adds[k]!.depth)) {
            for (let k = 0; k < adds.length; k++) {
                lines.push(`  changed:`, rel(adds[k]!), `    (was: ${dels[k]!.line})`);
                changes++;
            }
            continue;
        }
        if (dels.length) {
            lines.push("  removed:", ...dels.map(rel));
            changes += dels.length;
        }
        if (adds.length) {
            lines.push("  added:", ...adds.map(rel));
            changes += adds.length;
        }
    }
    return { text: lines.join("\n"), changes };
}

// ── one authoring session ───────────────────────────────────────────────────

export interface SnapshotTotals {
    /** Snapshots handed to the model (the first, after each action, and whole-page looks). */
    snapshots: number;
    /** Of those: sent as the whole compact snapshot. */
    compact: number;
    /** Of those: sent as only what changed. */
    diffs: number;
    /** Of those: the model asked for the whole page. */
    wholePage: number;
    /** Characters the same snapshots would have had before (the full snapshot, cut at the same limits as before). */
    baselineChars: number;
    /** Characters actually sent. */
    sentChars: number;
    /** Snapshot characters the model read over the whole conversation (each step resends every earlier snapshot), before and now. */
    baselineInputChars: number;
    sentInputChars: number;
}

export const WHOLE_PAGE_MAX = 16_000;
/** After this many change lists in a row the whole compact snapshot is sent again, so the model's picture never drifts far. */
export const FULL_EVERY = 10;
/** A change list longer than this share of the compact snapshot is not worth it: the compact snapshot is sent instead. */
const DIFF_WORTH = 0.6;

function cap(text: string, max: number, what: string): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max);
    return `${cut.slice(0, Math.max(0, cut.lastIndexOf("\n")))}\n…(${what} cut here; call seeWholePage for the rest)`;
}

const pageKeyOf = (url: string) => {
    try {
        const u = new URL(url);
        return `${u.origin}${u.pathname}`;
    } catch {
        return url;
    }
};

/**
 * Chooses, for each snapshot of one authoring session, between the compact snapshot and the list of changes, and keeps the counts.
 * The model always has the whole picture: the first snapshot of a page is complete (compact), every later one says what changed
 * relative to the last one it saw, and `whole()` gives the untouched snapshot on request.
 */
export class SnapshotView {
    private last?: { key: string; tree: SnapNode[] };
    private diffsInRow = 0;
    private sentHistory = 0;
    private baselineHistory = 0;
    readonly totals: SnapshotTotals = { snapshots: 0, compact: 0, diffs: 0, wholePage: 0, baselineChars: 0, sentChars: 0, baselineInputChars: 0, sentInputChars: 0 };

    /**
     * The text for the model. `raw` is the full snapshot; `max` is the limit the old full snapshot was cut at (counted as the
     * baseline) and the limit for what is sent now.
     */
    show(url: string, raw: string, max: number): string {
        const baseline = raw.length > max ? raw.slice(0, max) + "\n…(truncated)" : raw;
        let sent: string;
        if (!raw.startsWith("-")) {
            // "(accessibility snapshot unavailable)" and the like: passed on as they are, and the next snapshot is complete again.
            this.last = undefined;
            sent = baseline;
        } else {
            const { text, tree } = compactSnapshot(raw);
            const key = pageKeyOf(url);
            const summary = pageSummary(url, tree);
            const diff = this.last && this.last.key === key && this.diffsInRow < FULL_EVERY ? diffSnapshots(this.last.tree, tree) : undefined;
            if (diff && diff.changes === 0) {
                sent = `${summary}: nothing changed since your last look.`;
                this.diffsInRow++;
                this.totals.diffs++;
            } else if (diff && diff.text.length < text.length * DIFF_WORTH) {
                sent = cap(`${summary}, changes since your last look (the rest is as before):\n${diff.text}`, max, "the list of changes");
                this.diffsInRow++;
                this.totals.diffs++;
            } else {
                sent = cap(text, max, "the page");
                this.diffsInRow = 0;
                this.totals.compact++;
            }
            this.last = { key, tree };
        }
        this.count(baseline, sent);
        return sent;
    }

    /** The whole page as Playwright gives it, nothing left out (the seeWholePage tool). The next snapshot is compared with it. */
    whole(url: string, raw: string): string {
        const sent = raw.length > WHOLE_PAGE_MAX ? raw.slice(0, WHOLE_PAGE_MAX) + "\n…(truncated)" : raw;
        this.last = raw.startsWith("-") ? { key: pageKeyOf(url), tree: compactSnapshot(raw).tree } : undefined;
        this.diffsInRow = 0;
        this.totals.wholePage++;
        // Without smaller snapshots there is no such tool: its whole cost counts against the saving.
        this.count("", sent);
        return sent;
    }

    /**
     * Called when a model step finished (after its tool calls ran). That step read every snapshot handed over before it started:
     * the ones counted up to the end of the previous step (or, for the first step, the snapshot in the opening prompt).
     */
    modelStep(): void {
        this.steps++;
        this.totals.sentInputChars += this.readBySent;
        this.totals.baselineInputChars += this.readByBaseline;
        this.readBySent = this.sentHistory;
        this.readByBaseline = this.baselineHistory;
    }

    private steps = 0;
    private readBySent = 0;
    private readByBaseline = 0;

    private count(baseline: string, sent: string): void {
        this.totals.snapshots++;
        this.totals.baselineChars += baseline.length;
        this.totals.sentChars += sent.length;
        this.sentHistory += sent.length;
        this.baselineHistory += baseline.length;
        if (this.steps === 0 && this.totals.snapshots === 1) {
            this.readBySent = this.sentHistory;
            this.readByBaseline = this.baselineHistory;
        }
    }
}

/** How much of a page is read before compacting (the compact result is then cut at the old limits, so large pages lose less). */
export const RAW_SNAPSHOT_MAX = 60_000;

const tokens = (chars: number) => Math.ceil(chars / CHARS_PER_TOKEN);
const short = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/**
 * The job event with one session's counts, in estimated tokens (characters / 4, the usage feature's rule of thumb). "Read" counts every
 * model step: each step resends the earlier snapshots, so that is the input the saving really removes.
 */
export function snapshotSavingsEvent(subject: string, t: SnapshotTotals, kind: "web" | "phone" = "web"): EngineEvent {
    const before = tokens(kind === "web" ? t.baselineInputChars : t.baselineChars);
    const after = tokens(kind === "web" ? t.sentInputChars : t.sentChars);
    const saved = Math.max(0, before - after);
    const pct = before > 0 ? Math.round((saved / before) * 100) : 0;
    const what = kind === "web" ? "page snapshots" : "screen descriptions";
    return {
        stage: kind === "web" ? "generation" : "discovery",
        kind: EVENT_SNAPSHOT_SAVINGS,
        message:
            before > after
                ? `${subject}: smaller ${what}, about ${short(after)} tokens instead of ${short(before)} (${pct}% fewer)`
                : `${subject}: smaller ${what} saved nothing here (about ${short(after)} tokens)`,
        data: { kind, ...t, baselineTokens: before, sentTokens: after, savedTokens: saved },
    };
}

/** The note added to the authoring instructions when smaller snapshots are on (constant, so the instructions stay cacheable). */
export const COMPACT_SNAPSHOT_NOTE = `
Page snapshots are shortened (roles and names unchanged; a run of look-alike items lists the rest "In order"). On the same page you get only the changes since your last look. Never copy "[url=...]", "… (N more characters)" or "(N more" into a locator or expected value. For the full page call seeWholePage.`;
