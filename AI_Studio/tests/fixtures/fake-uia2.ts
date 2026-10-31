/**
 * A fake Android phone for the PLAN tests (R24): a LinkedIn-like app (feed, bottom navigation, jobs list, job details, search, profile, settings)
 * held as view trees, that answers both questions a real phone answers:
 *  - `dump(screen)`: the screen as `uiautomator dump` XML, so the platform's own parser (device/uiautomator.ts) reads it as during an exploration;
 *  - `FakeUia2Driver`: the WebDriver calls the real Taqwright `Mobile` and `Locator` classes make (findElements with id, accessibility id, class
 *    name, xpath and -android uiautomator, click, text, attributes, swipes), so a generated script's steps really run against it.
 * Never a real device, never adb, never Appium. The XPath and UiSelector readers understand the forms Taqwright and the generator write and
 * refuse anything else with an "invalid selector" error, so a typo in what the generator writes fails the test.
 */
export const PKG = "com.example.linkup";
const W = 1080;
const H = 2400;

export interface FakeNode {
    cls: string;
    /** Full resource id as Android reports it ("com.example.linkup:id/nav_jobs"), or a bare Compose test tag. */
    id?: string;
    text?: string;
    desc?: string;
    hint?: string;
    clickable?: boolean;
    scrollable?: boolean;
    selected?: boolean;
    b: [number, number, number, number];
    /** Tapping it opens this screen. */
    go?: string;
    kids?: FakeNode[];
}

export interface AppVersion {
    /** v2 renames some ids and labels, as an app update does: the tests' fallbacks must still find them. */
    v2?: boolean;
}

const rid = (x: string) => `${PKG}:id/${x}`;
const n = (o: FakeNode): FakeNode => o;
const tv = (id: string, text: string, b: FakeNode["b"], o: Partial<FakeNode> = {}): FakeNode => n({ cls: "android.widget.TextView", id: id ? rid(id) : undefined, text, b, ...o });

const JOBS = ["Android Developer", "QA Engineer", "Backend Engineer", "Data Analyst", "Product Manager", "Support Lead", "Product Designer", "Test Automation Engineer", "Site Reliability Engineer", "Mobile Architect"];
const VISIBLE_ROWS = 4;

/** The bottom navigation, with `selected` the open one. */
function bottomNav(selected: string, v2: boolean): FakeNode {
    const items: Array<[string, string, string]> = [
        ["nav_home", "Home", "home"],
        ["nav_network", "My Network", "network"],
        ["nav_post", "Post", "post"],
        ["nav_notifications", "Notifications, 3 new", "notifications"],
        [v2 ? "tab_jobs" : "nav_jobs", "Jobs", "jobs"],
    ];
    return n({
        cls: "com.google.android.material.bottomnavigation.BottomNavigationView",
        id: rid("bottom_nav"),
        b: [0, 2200, W, 2400],
        kids: items.map(([id, desc, go], i) => n({ cls: "com.google.android.material.bottomnavigation.BottomNavigationItemView", id: rid(id), desc, clickable: true, selected: go === selected, go, b: [i * 216, 2210, (i + 1) * 216, 2390] })),
    });
}

function toolbar(title: string, o: { up?: boolean; extra?: FakeNode[] } = {}): FakeNode {
    return n({
        cls: "androidx.appcompat.widget.Toolbar",
        id: rid("toolbar"),
        b: [0, 80, W, 240],
        kids: [...(o.up ? [n({ cls: "android.widget.ImageButton", desc: "Navigate up", clickable: true, go: "back", b: [0, 80, 160, 240] })] : []), tv("toolbar_title", title, [180, 110, 800, 210]), ...(o.extra ?? [])],
    });
}

const root = (kids: FakeNode[]): FakeNode => n({ cls: "android.widget.FrameLayout", b: [0, 0, W, H], kids: [n({ cls: "android.widget.LinearLayout", id: "android:id/content", b: [0, 0, W, H], kids })] });

export class FakePhoneApp {
    screen = "home";
    stack: string[] = [];
    /** First visible row of the jobs list. */
    jobsScroll = 0;
    feedScroll = 0;
    taps: string[] = [];
    typed: Record<string, string> = {};
    constructor(readonly version: AppVersion = {}) {}

    tree(screen = this.screen): FakeNode {
        const v2 = this.version.v2 === true;
        switch (screen) {
            case "home": {
                const posts = [0, 1, 2].map((k) => {
                    const p = this.feedScroll + k;
                    const top = 420 + k * 560;
                    return n({
                        cls: "android.widget.LinearLayout",
                        id: rid("feed_item"),
                        b: [0, top, W, top + 540],
                        kids: [
                            tv("actor_name", ["Ada Lovelace", "Grace Hopper", "Alan Turing", "Katherine Johnson", "Linus Torvalds"][p % 5]!, [40, top + 20, 700, top + 80]),
                            tv("post_time", `${p + 2}h`, [720, top + 20, 900, top + 80]),
                            tv("post_text", `Post number ${p + 1}: a long update about engineering, testing and the things people share on a busy professional feed every day.`, [40, top + 100, 1040, top + 400]),
                            tv("social_counts", `${12 + p} likes`, [40, top + 410, 400, top + 460]),
                            n({ cls: "android.widget.Button", id: rid("like_button"), text: "Like", clickable: true, b: [40, top + 470, 300, top + 530] }),
                        ],
                    });
                });
                return root([
                    n({
                        cls: "android.widget.LinearLayout",
                        id: rid("home_top_bar"),
                        b: [0, 80, W, 240],
                        kids: [n({ cls: "android.widget.TextView", id: rid("search_bar_text"), text: "Search", clickable: true, go: "search", b: [160, 110, 860, 210] }), n({ cls: "android.widget.ImageButton", id: rid("messaging_button"), desc: "Messaging", clickable: true, go: "messages", b: [900, 110, 1040, 210] })],
                    }),
                    n({ cls: "androidx.recyclerview.widget.RecyclerView", id: rid("feed_list"), scrollable: true, b: [0, 400, W, 2200], kids: posts }),
                    bottomNav("home", v2),
                ]);
            }
            case "jobs": {
                const rows = [];
                for (let k = 0; k < VISIBLE_ROWS && this.jobsScroll + k < JOBS.length; k++) {
                    const j = this.jobsScroll + k;
                    const top = 420 + k * 420;
                    rows.push(
                        n({
                            cls: "android.widget.LinearLayout",
                            id: rid("job_card"),
                            clickable: true,
                            go: `job:${j}`,
                            b: [0, top, W, top + 400],
                            kids: [tv("job_title", JOBS[j]!, [40, top + 30, 1000, top + 120]), tv("company_name", ["Initech", "Globex", "Umbrella", "Hooli"][j % 4]!, [40, top + 140, 1000, top + 220]), tv("posted", `${j + 1} days ago`, [40, top + 240, 600, top + 300])],
                        }),
                    );
                }
                return root([toolbar("Jobs"), n({ cls: "androidx.recyclerview.widget.RecyclerView", id: rid("jobs_list"), scrollable: true, b: [0, 400, W, 2200], kids: rows }), bottomNav("jobs", v2)]);
            }
            case "job": {
                const j = Number(this.stack.length ? (this.state.job ?? 0) : 0);
                return root([
                    toolbar("Job details", { up: true }),
                    tv("job_title", JOBS[j]!, [40, 300, 1040, 400]),
                    n({ cls: "android.widget.Button", id: rid(v2 ? "easy_apply" : "apply_button"), text: v2 ? "Easy Apply now" : "Easy Apply", clickable: true, go: "noop", b: [40, 500, 520, 620] }),
                    n({ cls: "android.widget.Button", id: rid("save_button"), text: "Save", clickable: true, go: "noop", b: [560, 500, 1040, 620] }),
                ]);
            }
            case "network":
                return root([
                    toolbar("My Network"),
                    // An app shrunk by R8: its ids say nothing ("a1", "b2c").
                    n({ cls: "android.widget.TextView", id: rid("a1"), text: "Invitations", clickable: true, go: "invitations", b: [40, 300, 1040, 400] }),
                    n({ cls: "android.widget.TextView", id: rid("b2c"), text: "Manage my network", clickable: true, go: "noop", b: [40, 420, 1040, 520] }),
                    bottomNav("network", v2),
                ]);
            case "invitations":
                return root([toolbar("Invitations", { up: true }), tv("", "No pending invitations", [40, 300, 1040, 400])]);
            case "post":
                // A Jetpack Compose screen: test tags as resource ids, without the package prefix.
                return root([
                    n({ cls: "android.view.View", id: "post_title", text: "Create a post", b: [40, 120, 1040, 220] }),
                    n({ cls: "android.widget.EditText", id: "post_editor", hint: "What do you want to talk about?", text: "What do you want to talk about?", clickable: true, b: [40, 300, 1040, 900] }),
                    n({ cls: "android.view.View", id: "post_close", desc: "Close", clickable: true, go: "back", b: [900, 120, 1040, 220] }),
                ]);
            case "notifications":
                return root([toolbar("Notifications"), tv("", "Ada Lovelace viewed your profile", [40, 300, 1040, 400]), bottomNav("notifications", v2)]);
            case "messages":
                return root([toolbar("Messaging", { up: true }), tv("", "No messages yet", [40, 300, 1040, 400])]);
            case "search":
                return root([
                    n({ cls: "android.widget.EditText", id: rid("search_input"), hint: "Search", text: this.typed.search ?? "Search", clickable: true, b: [160, 110, 900, 210] }),
                    ...(this.typed.search
                        ? [n({ cls: "androidx.recyclerview.widget.RecyclerView", id: rid("results_list"), scrollable: true, b: [0, 300, W, 2200], kids: [n({ cls: "android.widget.LinearLayout", id: rid("result_item"), clickable: true, go: "profile", b: [0, 300, W, 500], kids: [tv("result_name", "Ada Lovelace", [40, 320, 1000, 400])] })] })]
                        : []),
                ]);
            case "profile":
                return root([toolbar("Profile", { up: true }), tv("profile_name", "Ada Lovelace", [40, 300, 1040, 400]), n({ cls: "android.widget.Button", id: rid("settings_button"), text: "Settings", clickable: true, go: "settings", b: [40, 500, 1040, 620] })]);
            case "settings":
                return root([
                    toolbar("Settings", { up: true }),
                    n({ cls: "android.widget.TextView", id: rid("pref_account"), text: "Account preferences", clickable: true, go: "account", b: [40, 300, 1040, 400] }),
                    n({ cls: "android.widget.TextView", id: rid("pref_notifications"), text: "Notifications", clickable: true, go: "notif_settings", b: [40, 420, 1040, 520] }),
                    n({ cls: "android.widget.TextView", id: rid("sign_out"), text: "Sign out", clickable: true, go: "noop", b: [40, 540, 1040, 640] }),
                ]);
            case "account":
                return root([toolbar("Account preferences", { up: true }), tv("pref_display_name", "Name, location and industry", [40, 300, 1040, 400])]);
            case "notif_settings":
                return root([toolbar("Notifications", { up: true }), n({ cls: "android.widget.Switch", id: rid("push_switch"), text: "Push notifications", clickable: true, go: "noop", b: [40, 300, 1040, 400] })]);
            default:
                return root([]);
        }
    }

    state: { job?: number } = {};

    tap(node: FakeNode): void {
        this.taps.push(node.text || node.desc || node.id || node.cls);
        const go = node.go;
        if (!go || go === "noop") return;
        if (go === "back") return this.back();
        if (go.startsWith("job:")) {
            this.state.job = Number(go.slice(4));
            this.stack.push(this.screen);
            this.screen = "job";
            return;
        }
        // The bottom navigation switches sections; it does not stack them.
        if (["home", "network", "post", "notifications", "jobs"].includes(go) && ["home", "network", "notifications", "jobs"].includes(this.screen)) {
            this.screen = go;
            if (go === "post") this.stack = ["home"];
            return;
        }
        this.stack.push(this.screen);
        this.screen = go;
    }

    back(): void {
        this.screen = this.stack.pop() ?? this.screen;
    }

    /** A finger moved up the screen (content scrolls down) or down. */
    swipe(up: boolean): void {
        if (this.screen === "jobs") this.jobsScroll = Math.max(0, Math.min(JOBS.length - VISIBLE_ROWS, this.jobsScroll + (up ? 2 : -2)));
        if (this.screen === "home") this.feedScroll = Math.max(0, this.feedScroll + (up ? 1 : -1));
    }

    /** Start again from the first screen (a test's fresh start). */
    restart(): void {
        Object.assign(this, { screen: "home", stack: [], jobsScroll: 0, feedScroll: 0, typed: {}, state: {} });
    }
}

// ── the screen as `uiautomator dump` writes it ────────────────────────────

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

export function dump(app: FakePhoneApp, screen = app.screen): string {
    let idx = 0;
    const emit = (x: FakeNode): string => {
        const attrs = `index="${idx++}" text="${esc(x.text ?? "")}" resource-id="${esc(x.id ?? "")}" class="${x.cls}" package="${PKG}" content-desc="${esc(x.desc ?? "")}" checkable="false" checked="false" clickable="${x.clickable === true}" enabled="true" focusable="${x.clickable === true}" focused="false" scrollable="${x.scrollable === true}" long-clickable="false" password="false" selected="${x.selected === true}" bounds="[${x.b[0]},${x.b[1]}][${x.b[2]},${x.b[3]}]"`;
        return x.kids?.length ? `<node ${attrs}>${x.kids.map(emit).join("")}</node>` : `<node ${attrs} />`;
    };
    return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy rotation="0">${emit(app.tree(screen))}</hierarchy>`;
}

// ── a WebDriver client for Taqwright ───────────────────────────────────────

export const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";

interface Flat {
    node: FakeNode;
    parent: number;
    depth: number;
}

function flatten(rootNode: FakeNode): Flat[] {
    const out: Flat[] = [];
    const walk = (x: FakeNode, parent: number, depth: number) => {
        const me = out.length;
        out.push({ node: x, parent, depth });
        for (const k of x.kids ?? []) walk(k, me, depth + 1);
    };
    walk(rootNode, -1, 0);
    return out;
}

const attr = (x: FakeNode, name: string): string => {
    switch (name) {
        case "text":
            return x.text ?? "";
        case "resource-id":
            return x.id ?? "";
        case "content-desc":
            return x.desc ?? "";
        case "class":
            return x.cls;
        case "hint":
            return x.hint ?? "";
        case "selected":
            return String(x.selected === true);
        case "clickable":
            return String(x.clickable === true);
        default:
            return "";
    }
};

export class InvalidSelector extends Error {}

// ── XPath: the forms Taqwright and the generator write ──

type XVal = { kind: "attr"; name: string } | { kind: "lit"; v: string } | { kind: "fn"; name: string; args: XVal[] } | { kind: "num"; v: number } | { kind: "minus"; a: XVal; b: XVal };
type XExpr = { kind: "or"; parts: XExpr[] } | { kind: "eq"; a: XVal; b: XVal } | { kind: "contains"; a: XVal; b: XVal };

class XReader {
    pos = 0;
    constructor(private readonly s: string) {}
    ws() {
        while (this.s[this.pos] === " ") this.pos++;
    }
    peek(t: string) {
        this.ws();
        return this.s.startsWith(t, this.pos);
    }
    eat(t: string) {
        if (!this.peek(t)) throw new InvalidSelector(`xpath: expected ${t} at ${this.pos} in ${this.s}`);
        this.pos += t.length;
    }
    lit(): string {
        this.ws();
        const q = this.s[this.pos];
        if (q !== '"' && q !== "'") throw new InvalidSelector(`xpath: expected a string at ${this.pos} in ${this.s}`);
        const end = this.s.indexOf(q, this.pos + 1);
        if (end < 0) throw new InvalidSelector("xpath: open string");
        const v = this.s.slice(this.pos + 1, end);
        this.pos = end + 1;
        return v;
    }
    value(): XVal {
        this.ws();
        let left = this.atom();
        while (this.peek("-")) {
            this.eat("-");
            left = { kind: "minus", a: left, b: this.atom() };
        }
        return left;
    }
    atom(): XVal {
        this.ws();
        if (this.peek("@")) {
            this.eat("@");
            const m = /^[a-z-]+/.exec(this.s.slice(this.pos));
            if (!m) throw new InvalidSelector("xpath: attribute name");
            this.pos += m[0].length;
            return { kind: "attr", name: m[0] };
        }
        if (this.peek('"') || this.peek("'")) return { kind: "lit", v: this.lit() };
        const num = /^\d+/.exec(this.s.slice(this.pos));
        if (num) {
            this.pos += num[0].length;
            return { kind: "num", v: Number(num[0]) };
        }
        const fn = /^(concat|substring-after|substring|string-length)\(/.exec(this.s.slice(this.pos));
        if (!fn) throw new InvalidSelector(`xpath: unexpected ${this.s.slice(this.pos, this.pos + 12)} in ${this.s}`);
        this.pos += fn[0].length;
        const args: XVal[] = [this.value()];
        while (this.peek(",")) {
            this.eat(",");
            args.push(this.value());
        }
        this.eat(")");
        return { kind: "fn", name: fn[1]!, args };
    }
    expr(): XExpr {
        const parts: XExpr[] = [this.cmp()];
        while (this.peek("or ")) {
            this.eat("or ");
            parts.push(this.cmp());
        }
        return parts.length === 1 ? parts[0]! : { kind: "or", parts };
    }
    cmp(): XExpr {
        if (this.peek("contains(")) {
            this.eat("contains(");
            const a = this.value();
            this.eat(",");
            const b = this.value();
            this.eat(")");
            return { kind: "contains", a, b };
        }
        const a = this.value();
        this.eat("=");
        return { kind: "eq", a, b: this.value() };
    }
}

function xval(v: XVal, x: FakeNode): string | number {
    switch (v.kind) {
        case "attr":
            return attr(x, v.name);
        case "lit":
            return v.v;
        case "num":
            return v.v;
        case "minus":
            return Number(xval(v.a, x)) - Number(xval(v.b, x));
        case "fn": {
            const a = v.args.map((y) => xval(y, x));
            if (v.name === "concat") return a.join("");
            if (v.name === "string-length") return String(a[0]).length;
            if (v.name === "substring-after") {
                const s = String(a[0]);
                const i = s.indexOf(String(a[1]));
                return i < 0 ? "" : s.slice(i + String(a[1]).length);
            }
            // substring(s, start) with XPath's 1-based start.
            const s = String(a[0]);
            return s.slice(Math.max(0, Math.round(Number(a[1])) - 1));
        }
    }
}

function xtest(e: XExpr, x: FakeNode): boolean {
    if (e.kind === "or") return e.parts.some((p) => xtest(p, x));
    const a = xval(e.a, x);
    const b = xval(e.b, x);
    return e.kind === "eq" ? String(a) === String(b) : String(a).includes(String(b));
}

/** Evaluates `//*[...]//*[...]`, `//cls[...]`, `(path)[n]` over the flattened tree. */
export function xpathFind(flat: Flat[], xpath: string): number[] {
    const r = new XReader(xpath.trim());
    const path = (): number[] => {
        if (r.peek("(")) {
            r.eat("(");
            const inner = path();
            r.eat(")");
            r.eat("[");
            const m = /^\d+/.exec(xpath.trim().slice(r.pos));
            if (!m) throw new InvalidSelector("xpath: index");
            r.pos += m[0].length;
            r.eat("]");
            const one = inner[Number(m[0]) - 1];
            return one === undefined ? [] : [one];
        }
        let ctx: number[] | undefined;
        while (r.peek("//")) {
            r.eat("//");
            const name = /^(\*|[A-Za-z][\w.]*)/.exec(xpath.trim().slice(r.pos));
            if (!name) throw new InvalidSelector("xpath: step name");
            r.pos += name[0].length;
            const preds: XExpr[] = [];
            while (r.peek("[")) {
                r.eat("[");
                preds.push(r.expr());
                r.eat("]");
            }
            const isUnder = (i: number, anc: number[]) => {
                for (let p = flat[i]!.parent; p >= 0; p = flat[p]!.parent) if (anc.includes(p)) return true;
                return false;
            };
            const hits: number[] = [];
            flat.forEach((f, i) => {
                if (ctx && !isUnder(i, ctx)) return;
                if (name[0] !== "*" && f.node.cls !== name[0]) return;
                if (preds.every((p) => xtest(p, f.node))) hits.push(i);
            });
            ctx = hits;
        }
        if (!ctx) throw new InvalidSelector(`xpath: not understood: ${xpath}`);
        return ctx;
    };
    const out = path();
    if (r.pos !== xpath.trim().length) throw new InvalidSelector(`xpath: trailing text in ${xpath}`);
    return out;
}

// ── UiSelector: `new UiSelector().a(..).b(..)`, childSelector, UiScrollable.scrollIntoView ──

type Sel = { tests: Array<(x: FakeNode) => boolean>; instance?: number; child?: Sel };

class UiReader {
    pos = 0;
    constructor(private readonly s: string) {}
    peek(t: string) {
        return this.s.startsWith(t, this.pos);
    }
    eat(t: string) {
        if (!this.peek(t)) throw new InvalidSelector(`UiSelector: expected ${t} at ${this.pos} in ${this.s}`);
        this.pos += t.length;
    }
    str(): string {
        this.eat('"');
        let v = "";
        while (this.pos < this.s.length && this.s[this.pos] !== '"') {
            if (this.s[this.pos] === "\\") {
                v += this.s[this.pos + 1];
                this.pos += 2;
            } else v += this.s[this.pos++];
        }
        this.eat('"');
        return v;
    }
    selector(): Sel {
        this.eat("new UiSelector()");
        const sel: Sel = { tests: [] };
        while (this.peek(".")) {
            this.eat(".");
            const m = /^[A-Za-z]+/.exec(this.s.slice(this.pos));
            if (!m) throw new InvalidSelector("UiSelector: method");
            this.pos += m[0].length;
            this.eat("(");
            const name = m[0];
            if (name === "childSelector") sel.child = this.selector();
            else if (name === "instance") {
                const d = /^\d+/.exec(this.s.slice(this.pos));
                if (!d) throw new InvalidSelector("UiSelector: instance");
                this.pos += d[0].length;
                sel.instance = Number(d[0]);
            } else if (name === "scrollable") {
                const b = /^(true|false)/.exec(this.s.slice(this.pos));
                if (!b) throw new InvalidSelector("UiSelector: scrollable");
                this.pos += b[0].length;
                const want = b[0] === "true";
                sel.tests.push((x) => (x.scrollable === true) === want);
            } else {
                const v = this.str();
                const re = () => new RegExp(`^(?:${v})$`);
                const t: Record<string, (x: FakeNode) => boolean> = {
                    text: (x) => (x.text ?? "") === v,
                    description: (x) => (x.desc ?? "") === v,
                    resourceId: (x) => (x.id ?? "") === v,
                    resourceIdMatches: (x) => re().test(x.id ?? ""),
                    className: (x) => x.cls === v,
                    classNameMatches: (x) => re().test(x.cls),
                };
                if (!t[name]) throw new InvalidSelector(`UiSelector: unknown method ${name}`);
                sel.tests.push(t[name]!);
            }
            this.eat(")");
        }
        return sel;
    }
    end() {
        if (this.pos !== this.s.length) throw new InvalidSelector(`UiSelector: trailing text in ${this.s}`);
    }
}

function selFind(flat: Flat[], sel: Sel, within?: number[]): number[] {
    const isUnder = (i: number, anc: number[]) => {
        for (let p = flat[i]!.parent; p >= 0; p = flat[p]!.parent) if (anc.includes(p)) return true;
        return false;
    };
    let hits = flat.map((f, i) => ({ f, i })).filter(({ f, i }) => (!within || isUnder(i, within)) && sel.tests.every((t) => t(f.node))).map(({ i }) => i);
    if (sel.child) hits = selFind(flat, sel.child, hits);
    if (sel.instance !== undefined) hits = hits[sel.instance] !== undefined ? [hits[sel.instance]!] : [];
    return hits;
}

/** The WebDriver calls Taqwright's Mobile and Locator classes make, answered by the fake app. */
export class FakeUia2Driver {
    /** Every lookup asked for, to show which locator found what. */
    lookups: Array<{ using: string; value: string; found: number }> = [];
    constructor(readonly app: FakePhoneApp) {}

    private flat(): Flat[] {
        return flatten(this.app.tree());
    }
    private key(i: number): string {
        const a = this.app;
        return Buffer.from(`${a.screen}|${a.jobsScroll}|${a.feedScroll}|${i}`).toString("base64url");
    }
    private node(id: string): FakeNode {
        const [screen, js, fs, i] = Buffer.from(id, "base64url").toString("utf8").split("|");
        const a = this.app;
        if (screen !== a.screen || Number(js) !== a.jobsScroll || Number(fs) !== a.feedScroll) throw Object.assign(new Error("stale element reference"), { name: "stale element reference" });
        return this.flat()[Number(i)]!.node;
    }

    private find(using: string, value: string): number[] {
        const flat = this.flat();
        switch (using) {
            case "id":
                // Appium puts the app's package in front of an id without one (a Compose test tag is then not found).
                return flat.map((f, i) => ({ f, i })).filter(({ f }) => f.node.id === (value.includes(":id/") ? value : `${PKG}:id/${value}`)).map(({ i }) => i);
            case "accessibility id":
                return flat.map((f, i) => ({ f, i })).filter(({ f }) => f.node.desc === value).map(({ i }) => i);
            case "class name":
                return flat.map((f, i) => ({ f, i })).filter(({ f }) => f.node.cls === value).map(({ i }) => i);
            case "xpath":
                return xpathFind(flat, value);
            case "-android uiautomator": {
                const scroll = /^new UiScrollable\((.*)\)\.scrollIntoView\((.*)\)$/.exec(value);
                if (scroll) {
                    // UiScrollable: scroll the list down until the element shows (at most 10 times).
                    const target = new UiReader(scroll[2]!);
                    const sel = target.selector();
                    target.end();
                    for (let k = 0; k < 10; k++) {
                        const hits = selFind(this.flat(), sel);
                        if (hits.length) return hits.slice(0, 1);
                        this.app.swipe(true);
                    }
                    return [];
                }
                const r = new UiReader(value);
                const sel = r.selector();
                r.end();
                return selFind(flat, sel);
            }
            default:
                throw new InvalidSelector(`unsupported strategy ${using}`);
        }
    }

    async findElements(using: string, value: string): Promise<Array<Record<string, string>>> {
        const hits = this.find(using, value);
        this.lookups.push({ using, value, found: hits.length });
        return hits.map((i) => ({ [ELEMENT]: this.key(i) }));
    }
    async findElement(using: string, value: string): Promise<Record<string, string>> {
        const all = await this.findElements(using, value);
        if (!all.length) throw Object.assign(new Error(`no such element: ${using} ${value}`), { name: "no such element" });
        return all[0]!;
    }
    async findElementsFromElement(parent: string, using: string, value: string): Promise<Array<Record<string, string>>> {
        this.node(parent);
        return this.findElements(using, value);
    }
    async isElementDisplayed(id: string): Promise<boolean> {
        this.node(id);
        return true;
    }
    async isElementEnabled(id: string): Promise<boolean> {
        this.node(id);
        return true;
    }
    async getElementText(id: string): Promise<string> {
        return this.node(id).text ?? "";
    }
    async getElementAttribute(id: string, name: string): Promise<string | null> {
        return attr(this.node(id), name) || null;
    }
    async getElementRect(id: string): Promise<{ x: number; y: number; width: number; height: number }> {
        const b = this.node(id).b;
        return { x: b[0], y: b[1], width: b[2] - b[0], height: b[3] - b[1] };
    }
    async getWindowRect(): Promise<{ x: number; y: number; width: number; height: number }> {
        return { x: 0, y: 0, width: W, height: H };
    }
    async elementClick(id: string): Promise<void> {
        this.node(id);
        // A tap lands on the element's centre: the nearest view that takes taps there gets it (a row's title taps the row).
        const flat = this.flat();
        let i = Number(Buffer.from(id, "base64url").toString("utf8").split("|")[3]);
        while (i >= 0 && !flat[i]!.node.clickable) i = flat[i]!.parent;
        if (i >= 0) this.app.tap(flat[i]!.node);
    }
    async elementClear(id: string): Promise<void> {
        this.node(id);
    }
    async elementSendKeys(id: string, text: string): Promise<void> {
        const node = this.node(id);
        if (node.id === `${PKG}:id/search_input`) this.app.typed.search = text;
    }
    async performActions(actions: Array<{ actions: Array<{ type: string; x?: number; y?: number }> }>): Promise<void> {
        const moves = (actions[0]?.actions ?? []).filter((a) => a.type === "pointerMove");
        const from = moves[0];
        const to = moves.at(-1);
        if (from && to && Math.abs((to.y ?? 0) - (from.y ?? 0)) > 50) this.app.swipe((to.y ?? 0) < (from.y ?? 0));
    }
    async releaseActions(): Promise<void> {}
    async back(): Promise<void> {
        this.app.back();
    }
    async getPageSource(): Promise<string> {
        return dump(this.app);
    }
    async executeScript(script: string, args: unknown[]): Promise<unknown> {
        const arg = (args[0] ?? {}) as Record<string, unknown>;
        if (script === "mobile: pressKey" && arg.keycode === 4) return void this.app.back();
        if (script === "mobile: swipeGesture" || script === "mobile: scrollGesture") return void this.app.swipe(arg.direction === "up" || arg.direction === "down");
        throw new Error(`unknown script ${script}`);
    }
}
