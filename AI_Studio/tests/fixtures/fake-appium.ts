/**
 * A local fake device farm for the tests: a small W3C WebDriver (Appium) server that serves the mock "shop" app (the same screens and ids as
 * fake-adb.mjs's shop), plus the providers' REST endpoints the platform uses (app upload, result reporting, connection check). Never a real farm.
 *
 * Paths: /<provider>/hub/... (WebDriver), /<provider>/api/... (REST), where provider is browserstack | saucelabs | lambdatest; "Any Appium server" is
 * /appium/wd/hub/... Everything received is recorded in `log` so the tests can check what reached the farm and how.
 */
import http from "node:http";
import zlib from "node:zlib";

export const ELEMENT = "element-6066-11e4-a52e-4f735466cecf";
const PKG = "com.example.shop";
const W = 360;
const H = 640;

export interface FakeFarmOptions {
    port: number;
    /** Accepted account (Basic user:key) for the cloud providers. */
    user: string;
    key: string;
    /** The shop's test account. */
    shopUser?: string;
    shopPassword?: string;
    /** Sessions asking for this device name are refused ("no device free"). */
    busyDevice?: string;
    /** Delay of every WebDriver answer, ms. */
    delayMs?: number;
}

export interface LoggedRequest {
    method: string;
    path: string;
    auth: string | undefined;
    body: string;
}

interface Node {
    cls: string;
    id: string;
    text: string;
    desc: string;
    hint: string;
    b: [number, number, number, number];
    clickable: boolean;
    enabled: boolean;
    password: boolean;
    focused: boolean;
    scrollable: boolean;
    act?: string;
    kids: Node[];
}

interface App {
    fg: boolean;
    screen: string;
    loggedIn: boolean;
    fields: Record<string, string>;
    focus: string | null;
    keyboard: boolean;
    error: string;
    cart: number[];
    product: number;
    scroll: number;
}

interface Session {
    id: string;
    caps: Record<string, unknown>;
    app: App;
    deleted: boolean;
}

const fresh = (): App => ({ fg: false, screen: "home", loggedIn: false, fields: { username: "", password: "", search: "" }, focus: null, keyboard: false, error: "", cart: [], product: 0, scroll: 0 });

const n = (o: Partial<Node> & { b: Node["b"] }): Node => ({ cls: "android.widget.TextView", id: "", text: "", desc: "", hint: "", clickable: false, enabled: true, password: false, focused: false, scrollable: false, kids: [], ...o });
const rid = (x: string) => `${PKG}:id/${x}`;

function screenOf(a: App): Node {
    const kids: Node[] = [];
    const btn = (id: string, text: string, b: Node["b"], act: string, o: Partial<Node> = {}) => n({ cls: "android.widget.Button", id: rid(id), text, b, act, clickable: true, ...o });
    const label = (id: string, text: string, b: Node["b"]) => n({ id: rid(id), text, b });
    const edit = (id: string, field: string, hint: string, b: Node["b"], password = false) =>
        n({ cls: "android.widget.EditText", id: rid(id), text: password ? "•".repeat(a.fields[field]!.length) : a.fields[field]!, hint, b, act: `focus:${field}`, clickable: true, password, focused: a.focus === field });
    if (!a.fg) return n({ cls: "android.widget.FrameLayout", b: [0, 0, W, H], kids: [n({ id: "com.android.launcher3:id/icon", text: "Shop", b: [20, 100, 100, 160] })] });
    switch (a.screen) {
        case "signin":
            kids.push(label("title", "Sign in", [16, 60, 344, 100]), edit("username_field", "username", "Username", [16, 120, 344, 168]), edit("password_field", "password", "Password", [16, 184, 344, 232], true), btn("login_button", "Log in", [16, 256, 344, 304], "login"));
            if (a.error) kids.push(label("error_text", a.error, [16, 320, 344, 360]));
            break;
        case "products": {
            const rows: Node[] = [];
            for (let k = 0; k < 6 && a.scroll + k < 12; k++) rows.push(n({ id: rid(`product_${a.scroll + k + 1}`), text: `Product ${a.scroll + k + 1}`, b: [16, 100 + k * 60, 344, 150 + k * 60], clickable: true, act: `product:${a.scroll + k + 1}` }));
            kids.push(label("title", "Products", [16, 40, 344, 80]), n({ cls: "androidx.recyclerview.widget.RecyclerView", id: rid("product_list"), b: [0, 90, W, 480], scrollable: true, kids: rows }));
            break;
        }
        case "product":
            kids.push(label("product_title", `Product ${a.product}`, [16, 60, 344, 100]), label("price", "$9.99", [16, 110, 344, 150]), btn("add_to_cart_button", "Add to cart", [16, 200, 344, 248], "add-cart"));
            break;
        case "cart":
            kids.push(label("title", "Cart", [16, 40, 344, 80]), ...(a.cart.length ? a.cart.map((p, i) => label(`cart_item_${i}`, `Product ${p}`, [16, 100 + i * 40, 344, 136 + i * 40])) : [label("empty", "Your cart is empty", [16, 100, 344, 140])]), btn("checkout_button", "Check out", [16, 560, 344, 608], "noop", { enabled: a.cart.length > 0 }));
            break;
        default:
            kids.push(n({ cls: "android.widget.FrameLayout", id: rid("toolbar"), b: [0, 0, W, 56], kids: [label("toolbar_title", "Shop", [16, 12, 120, 44])] }), edit("search_box", "search", "Search products", [16, 72, 344, 120]));
            if (a.loggedIn) kids.push(label("welcome", `Hello, ${a.fields.username}`, [16, 136, 344, 176]), btn("logout_button", "Log out", [16, 184, 344, 232], "logout"));
            else kids.push(btn("signin_button", "Sign in", [16, 136, 344, 184], "goto:signin"));
            kids.push(btn("products_button", "Products", [16, 248, 344, 296], "goto:products"), n({ cls: "android.widget.ImageButton", id: rid("cart_button"), desc: `Cart, ${a.cart.length} items`, b: [16, 312, 120, 360], clickable: true, act: "goto:cart" }));
    }
    return n({ cls: "android.widget.FrameLayout", b: [0, 0, W, H], kids: [n({ cls: "android.widget.LinearLayout", b: [0, 0, W, H], kids })] });
}

function flatten(root: Node): Node[] {
    const out: Node[] = [];
    const walk = (x: Node) => {
        out.push(x);
        x.kids.forEach(walk);
    };
    walk(root);
    return out;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Page source as Appium's UiAutomator2 driver writes it: tags named by class. */
function sourceOf(a: App): string {
    let idx = 0;
    const pkg = a.fg ? PKG : "com.android.launcher3";
    const emit = (x: Node): string => {
        const attrs = `index="${idx++}" package="${pkg}" class="${x.cls}" text="${esc(x.text)}" resource-id="${esc(x.id)}" content-desc="${esc(x.desc)}" hint="${esc(x.hint)}" checkable="false" checked="false" clickable="${x.clickable}" enabled="${x.enabled}" focusable="${x.clickable}" focused="${x.focused}" long-clickable="false" password="${x.password}" scrollable="${x.scrollable}" selected="false" bounds="[${x.b[0]},${x.b[1]}][${x.b[2]},${x.b[3]}]" displayed="true"`;
        return x.kids.length ? `<${x.cls} ${attrs}>${x.kids.map(emit).join("")}</${x.cls}>` : `<${x.cls} ${attrs} />`;
    };
    return `<?xml version='1.0' encoding='UTF-8' standalone='yes' ?><hierarchy index="0" class="hierarchy" rotation="0" width="${W}" height="${H}">${emit(screenOf(a))}</hierarchy>`;
}

function png(): Buffer {
    const raw = Buffer.alloc((W * 3 + 1) * H);
    for (let y = 0; y < H; y++) {
        raw[y * (W * 3 + 1)] = 0;
        for (let x = 0; x < W; x++) raw.set([240, 240, 245], y * (W * 3 + 1) + 1 + x * 3);
    }
    const chunk = (type: string, data: Buffer) => {
        const len = Buffer.alloc(4);
        len.writeUInt32BE(data.length);
        const td = Buffer.concat([Buffer.from(type), data]);
        const crc = Buffer.alloc(4);
        crc.writeUInt32BE(zlib.crc32(td) >>> 0);
        return Buffer.concat([len, td, crc]);
    };
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(W, 0);
    ihdr.writeUInt32BE(H, 4);
    ihdr.set([8, 2, 0, 0, 0], 8);
    return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const PNG = png();

/** `'x'`, `"x"` or `concat('a', "'", 'b')`. */
function xpathString(s: string): string | undefined {
    const t = s.trim();
    if (/^'[^']*'$/.test(t) || /^"[^"]*"$/.test(t)) return t.slice(1, -1);
    const c = /^concat\((.*)\)$/.exec(t);
    if (!c) return undefined;
    const parts = c[1]!.match(/'[^']*'|"[^"]*"/g) ?? [];
    return parts.map((p) => p.slice(1, -1)).join("");
}

function matches(nodes: Node[], using: string, value: string): Node[] | undefined {
    switch (using) {
        case "id":
            return nodes.filter((x) => x.id === value || x.id === `${PKG}:id/${value}`);
        case "accessibility id":
            return nodes.filter((x) => x.desc === value);
        case "class name":
            return nodes.filter((x) => x.cls === value);
        case "xpath": {
            const eq = /^\/\/\*\[@([a-z-]+)=(.*)\]$/.exec(value);
            if (eq) {
                const want = xpathString(eq[2]!);
                return want === undefined ? undefined : nodes.filter((x) => attr(x, eq[1]!) === want);
            }
            const has = /^\/\/\*\[contains\(@([a-z-]+), (.*)\)\]$/.exec(value);
            if (has) {
                const want = xpathString(has[2]!);
                return want === undefined ? undefined : nodes.filter((x) => attr(x, has[1]!).includes(want));
            }
            return undefined;
        }
    }
    return undefined;
}

function attr(x: Node, name: string): string {
    switch (name) {
        case "text":
            return x.text;
        case "hint":
            return x.hint;
        case "content-desc":
            return x.desc;
        case "resource-id":
            return x.id;
        case "checked":
            return "false";
        case "class":
            return x.cls;
        default:
            return "";
    }
}

export interface FakeFarm {
    url: string;
    log: LoggedRequest[];
    sessions: Map<string, Session>;
    uploads: Array<{ provider: string; bytes: number; auth: string | undefined }>;
    statuses: Array<{ provider: string; sessionId: string; body: unknown }>;
    /** Text typed into fields, per session (the password reaches the farm's phone, and only there). */
    typed: string[];
    maxConcurrent: number;
    close(): Promise<void>;
}

export async function startFakeFarm(o: FakeFarmOptions): Promise<FakeFarm> {
    const log: LoggedRequest[] = [];
    const sessions = new Map<string, Session>();
    const uploads: FakeFarm["uploads"] = [];
    const statuses: FakeFarm["statuses"] = [];
    const typed: string[] = [];
    let open = 0;
    let seq = 0;
    const state = { maxConcurrent: 0 };
    const expected = `Basic ${Buffer.from(`${o.user}:${o.key}`).toString("base64")}`;
    const shopUser = o.shopUser ?? "tester";
    const shopPassword = o.shopPassword ?? "Fake-Pass-1234";

    const server = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
            const raw = Buffer.concat(chunks);
            const body = raw.toString("utf8");
            const url = new URL(req.url ?? "/", "http://x");
            const p = url.pathname;
            log.push({ method: req.method ?? "", path: p + url.search, auth: req.headers.authorization, body: req.headers["content-type"]?.startsWith("multipart/") ? `[multipart ${raw.length} bytes]` : body });
            const send = (status: number, value: unknown) => {
                const go = () => {
                    res.writeHead(status, { "content-type": "application/json" });
                    res.end(JSON.stringify({ value }));
                };
                if (o.delayMs) setTimeout(go, o.delayMs);
                else go();
            };
            const sendRaw = (status: number, v: unknown) => {
                res.writeHead(status, { "content-type": "application/json" });
                res.end(JSON.stringify(v));
            };
            const m = /^\/(browserstack|saucelabs|lambdatest|appium)\/(hub|api|wd\/hub)(\/.*)?$/.exec(p);
            if (!m) return sendRaw(404, { error: "unknown" });
            const provider = m[1]!;
            const kind = m[2] === "api" ? "api" : "hub";
            const rest = m[3] ?? "/";
            if (provider !== "appium" && req.headers.authorization !== expected) return sendRaw(401, { value: { error: "unauthorized", message: `Authorization failed for ${o.user}` } });
            if (kind === "api") return api(provider, req.method ?? "", rest, raw, req.headers.authorization, sendRaw);
            return hub(req.method ?? "", rest, body, send);
        });
    });

    function api(provider: string, method: string, rest: string, raw: Buffer, auth: string | undefined, send: (s: number, v: unknown) => void) {
        if (method === "POST" && /\/(app-automate\/upload|v1\/storage\/upload|app\/upload\/realDevice)$/.test(rest)) {
            uploads.push({ provider, bytes: raw.length, auth });
            if (provider === "saucelabs") return send(201, { item: { id: "sauce-app-1" } });
            return send(200, { app_url: provider === "browserstack" ? "bs://fakeapp123" : "lt://APP1001" });
        }
        const status = /^\/app-automate\/sessions\/([^/]+)\.json$/.exec(rest) ?? /^\/rest\/v1\/[^/]+\/jobs\/([^/]+)$/.exec(rest) ?? /^\/mobile-automation\/api\/v1\/sessions\/([^/]+)$/.exec(rest);
        if (status && (method === "PUT" || method === "PATCH")) {
            statuses.push({ provider, sessionId: status[1]!, body: JSON.parse(raw.toString("utf8") || "{}") });
            return send(200, { ok: true });
        }
        if (method === "GET") return send(200, { ok: true });
        return send(404, { error: "unknown" });
    }

    function hub(method: string, rest: string, body: string, send: (s: number, v: unknown) => void) {
        const json = (() => {
            try {
                return body ? JSON.parse(body) : {};
            } catch {
                return {};
            }
        })();
        if (method === "GET" && rest === "/status") return send(200, { ready: true, message: "fake appium" });
        if (method === "POST" && rest === "/session") {
            const caps = (json.capabilities?.alwaysMatch ?? {}) as Record<string, unknown>;
            const opts = (caps["bstack:options"] ?? caps["lt:options"] ?? {}) as Record<string, unknown>;
            const device = String(opts.deviceName ?? caps["appium:deviceName"] ?? "");
            if (o.busyDevice && device === o.busyDevice) return send(500, { error: "session not created", message: `No device free: ${device}` });
            const id = `s${++seq}x${Date.now().toString(36)}`;
            sessions.set(id, { id, caps, app: fresh(), deleted: false });
            open++;
            state.maxConcurrent = Math.max(state.maxConcurrent, open);
            return send(200, { sessionId: id, capabilities: caps });
        }
        const sm = /^\/session\/([^/]+)(\/.*)?$/.exec(rest);
        if (!sm) return send(404, { error: "unknown command", message: rest });
        const s = sessions.get(sm[1]!);
        if (!s || s.deleted) return send(404, { error: "invalid session id", message: "no such session" });
        const sub = sm[2] ?? "";
        const a = s.app;
        const nodes = () => flatten(screenOf(a));
        const elId = (i: number) => Buffer.from(`${a.fg ? a.screen : "launcher"}|${a.scroll}|${i}`).toString("base64url");
        const byId = (eid: string): Node | undefined => {
            const [scr, scroll, i] = Buffer.from(eid, "base64url").toString("utf8").split("|");
            if (scr !== (a.fg ? a.screen : "launcher") || Number(scroll) !== a.scroll) return undefined;
            return nodes()[Number(i)];
        };
        if (method === "DELETE" && sub === "") {
            s.deleted = true;
            open--;
            return send(200, null);
        }
        if (method === "GET" && sub === "/source") return send(200, sourceOf(a));
        if (method === "GET" && sub === "/screenshot") return send(200, PNG.toString("base64"));
        if (method === "GET" && sub === "/window/rect") return send(200, { x: 0, y: 0, width: W, height: H });
        if (method === "POST" && sub === "/back") {
            back(a);
            return send(200, null);
        }
        if (method === "POST" && sub === "/elements") {
            const all = nodes();
            const found = matches(all, json.using, json.value);
            if (!found) return send(400, { error: "invalid selector", message: `unsupported: ${json.using} ${json.value}` });
            return send(200, found.map((x) => ({ [ELEMENT]: elId(all.indexOf(x)) })));
        }
        if (method === "GET" && sub === "/element/active") {
            const all = nodes();
            const f = all.findIndex((x) => x.focused);
            return f === -1 ? send(404, { error: "no such element", message: "nothing focused" }) : send(200, { [ELEMENT]: elId(f) });
        }
        const em = /^\/element\/([^/]+)\/(click|clear|value|text|displayed|enabled|attribute\/[a-z-]+)$/.exec(sub);
        if (em) {
            const el = byId(em[1]!);
            if (!el) return send(404, { error: "stale element reference", message: "The element is not on the screen any more" });
            const what = em[2]!;
            if (what === "click") {
                tap(a, el);
                return send(200, null);
            }
            if (what === "clear" || what === "value") {
                const field = el.act?.startsWith("focus:") ? el.act.slice(6) : undefined;
                if (!field) return send(400, { error: "invalid element state", message: "not a text field" });
                if (what === "clear") a.fields[field] = "";
                else {
                    a.fields[field] = (a.fields[field] ?? "") + String(json.text ?? "");
                    typed.push(String(json.text ?? ""));
                }
                a.focus = field;
                return send(200, null);
            }
            if (what === "text") return send(200, el.text);
            if (what === "displayed") return send(200, true);
            if (what === "enabled") return send(200, el.enabled);
            return send(200, attr(el, what.slice("attribute/".length)) || null);
        }
        if (method === "POST" && sub === "/actions") {
            const acts = (json.actions?.[0]?.actions ?? []) as Array<{ type: string; x?: number; y?: number }>;
            const moves = acts.filter((x) => x.type === "pointerMove");
            const from = moves[0];
            const to = moves[moves.length - 1];
            if (from && to && (Math.abs((to.y ?? 0) - (from.y ?? 0)) > 20 || Math.abs((to.x ?? 0) - (from.x ?? 0)) > 20)) {
                if (a.screen === "products") a.scroll = Math.max(0, Math.min(6, a.scroll + ((to.y ?? 0) < (from.y ?? 0) ? 3 : -3)));
            } else if (from) {
                const hit = nodes()
                    .filter((x) => x.clickable && from.x! >= x.b[0] && from.x! < x.b[2] && from.y! >= x.b[1] && from.y! < x.b[3])
                    .pop();
                if (hit) tap(a, hit);
            }
            return send(200, null);
        }
        if (method === "POST" && sub === "/execute/sync") {
            const script = String(json.script ?? "");
            const arg = (json.args?.[0] ?? {}) as Record<string, unknown>;
            switch (script) {
                case "mobile: activateApp":
                    if (arg.appId !== PKG) return send(500, { error: "unknown error", message: `App ${String(arg.appId)} is not installed` });
                    if (!a.fg) Object.assign(a, { ...fresh(), fg: true, loggedIn: false });
                    return send(200, null);
                case "mobile: terminateApp":
                    if (arg.appId === PKG) Object.assign(a, fresh());
                    return send(200, true);
                case "mobile: pressKey":
                    if (arg.keycode === 4) back(a);
                    if (arg.keycode === 3) a.fg = false;
                    return send(200, null);
                case "mobile: isKeyboardShown":
                    return send(200, a.keyboard);
                case "mobile: getCurrentActivity":
                    return send(200, a.fg ? `.${a.screen[0]!.toUpperCase()}${a.screen.slice(1)}Activity` : "com.android.launcher3.Launcher");
                case "mobile: getCurrentPackage":
                    return send(200, a.fg ? PKG : "com.android.launcher3");
                case "mobile: deepLink":
                    a.fg = true;
                    a.screen = String(arg.url ?? "").endsWith("/cart") ? "cart" : "home";
                    return send(200, null);
                default:
                    return send(400, { error: "unknown command", message: script });
            }
        }
        return send(404, { error: "unknown command", message: `${method} ${sub}` });
    }

    function back(a: App) {
        if (a.keyboard) a.keyboard = false;
        else if (!a.fg) return;
        else if (a.screen === "product") a.screen = "products";
        else if (a.screen === "home") a.fg = false;
        else a.screen = "home";
    }

    function tap(a: App, el: Node) {
        if (!el.enabled || !el.act) return;
        const act = el.act;
        if (act.startsWith("focus:")) {
            a.focus = act.slice(6);
            a.keyboard = true;
        } else if (act.startsWith("goto:")) {
            a.screen = act.slice(5);
            a.focus = null;
        } else if (act === "login") {
            if (a.fields.username === shopUser && a.fields.password === shopPassword) {
                a.loggedIn = true;
                a.screen = "home";
                a.error = "";
            } else a.error = "Wrong username or password";
        } else if (act === "logout") a.loggedIn = false;
        else if (act.startsWith("product:")) {
            a.product = Number(act.slice(8));
            a.screen = "product";
        } else if (act === "add-cart") a.cart.push(a.product);
    }

    await new Promise<void>((r) => server.listen(o.port, "127.0.0.1", r));
    return {
        url: `http://127.0.0.1:${o.port}`,
        log,
        sessions,
        uploads,
        statuses,
        typed,
        get maxConcurrent() {
            return state.maxConcurrent;
        },
        close: () =>
            new Promise<void>((r) => {
                server.closeAllConnections();
                server.close(() => r());
            }),
    };
}
