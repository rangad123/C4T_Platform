/**
 * An in-memory phone for the fast tests of the AI phone explorer: a small scripted app behind the same `DeviceSession` interface the real session has
 * (src/engine/mobile/device/types.ts). No adb, no emulator, no process. It keeps a log of everything the explorer did, so a test can say what was
 * never tapped or typed. The integration tests use the fake adb (tests/fixtures/fake-adb.mjs) instead.
 *
 * Credentials: a `{{credentials.*}}` placeholder is replaced by the real value here, inside the "phone", exactly as the real session does it on the
 * machine that owns the phone. The real value is stored only in the app's own field and in `realTyped`, never returned in a snapshot.
 */
import { createHash } from "node:crypto";
import type { ActResult, DeviceAction, DeviceSession, OpenDeviceOptions, ScreenElement, ScreenSnapshot } from "../../src/engine/mobile/device/types.js";

export interface El {
    cls?: string;
    text?: string;
    desc?: string;
    id?: string;
    /** Tapping goes to this screen, or runs this function. */
    tap?: string | ((d: MemoryDevice) => void);
    /** An input: the name of the field it edits. */
    field?: string;
    password?: boolean;
    scrollable?: boolean;
    checkable?: boolean;
    enabled?: boolean;
    /** Added in R24 (EXPLORE): where it is on the screen (default: one row of 40 px per element) and whether it is the selected tab. */
    bounds?: [number, number, number, number];
    selected?: boolean;
    checked?: boolean;
    clickable?: boolean;
}

export interface Screen {
    activity?: string;
    pkg?: string;
    /** The elements, built when the screen is read (so they can show the app's state). */
    els: (d: MemoryDevice) => El[];
}

export interface AppDef {
    pkg: string;
    start: string;
    screens: Record<string, Screen>;
    /** What the screen shows after the app is started (a permission dialog, for example). Default: `start`. */
    onLaunch?: (d: MemoryDevice) => string;
}

export class MemoryDevice implements DeviceSession {
    readonly kind = "local" as const;
    readonly deviceName = "Memory phone";
    screen: string;
    stack: string[] = [];
    fields: Record<string, string> = {};
    state: Record<string, unknown> = {};
    /** Every action the explorer asked for and the phone accepted. */
    acts: DeviceAction[] = [];
    /** What was tapped, by the words on the element. */
    tapped: string[] = [];
    /** Real text that went into a field (after placeholder substitution), by field name. */
    realTyped: Array<{ field: string; text: string }> = [];
    closed = false;
    /** The next this-many actions fail the way a busy phone does. */
    failActs = 0;
    snapshots = 0;
    /** Pictures the phone was asked to make. */
    shots = 0;
    private last: Array<El & { index: number }> = [];

    constructor(
        readonly app: AppDef,
        private readonly opts: Partial<OpenDeviceOptions> = {},
    ) {
        this.screen = app.start;
    }

    goto(name: string, push = true): void {
        if (push) this.stack.push(this.screen);
        this.screen = name;
    }

    private elements(): Array<El & { index: number }> {
        const sc = this.app.screens[this.screen]!;
        return sc.els(this).map((e, index) => ({ ...e, index }));
    }

    private snap(shot: boolean): ScreenSnapshot {
        this.snapshots++;
        if (shot) this.shots++;
        const sc = this.app.screens[this.screen]!;
        const pkg = sc.pkg ?? this.app.pkg;
        const els = this.elements();
        this.last = els;
        const elements: ScreenElement[] = els.map((e, i) => {
            const editable = e.field !== undefined;
            return {
                index: i,
                cls: e.cls ?? (editable ? "EditText" : e.tap ? "Button" : "TextView"),
                text: e.password ? "" : editable ? (this.fields[e.field!] ?? e.text ?? "") : (e.text ?? ""),
                desc: e.desc ?? "",
                id: e.id ?? "",
                clickable: e.clickable ?? (Boolean(e.tap) || editable),
                longClickable: false,
                scrollable: e.scrollable === true,
                editable,
                password: e.password === true,
                checkable: e.checkable === true,
                checked: e.checked === true,
                enabled: e.enabled !== false,
                focused: false,
                bounds: e.bounds ?? [0, i * 40, 360, i * 40 + 36],
                ...(e.selected ? { selected: true as const } : {}),
            };
        });
        const fingerprint = createHash("sha1").update(`${pkg}|${sc.activity ?? ""}|${elements.map((e) => `${e.id}|${e.text}|${e.desc}`).join("\n")}`).digest("hex").slice(0, 16);
        return {
            package: pkg,
            ...(sc.activity ? { activity: sc.activity } : {}),
            width: 360,
            height: 640,
            elements,
            fingerprint,
            keyboard: false,
            outsideApp: pkg !== this.app.pkg,
            ...(shot ? { screenshot: Buffer.from("not-really-a-jpeg").toString("base64") } : {}),
        };
    }

    async snapshot(o: { screenshot?: boolean } = {}): Promise<ScreenSnapshot> {
        return this.snap(o.screenshot === true);
    }

    async act(action: DeviceAction, o: { screenshot?: boolean } = {}): Promise<ActResult> {
        const fail = (error: string): ActResult => ({ ok: false, error });
        if (this.failActs > 0) {
            this.failActs--;
            return fail("The phone is busy");
        }
        if (action.kind === "launch" || action.kind === "restart") {
            this.stack = [];
            this.screen = this.app.onLaunch ? this.app.onLaunch(this) : this.app.start;
        } else if (action.kind === "back") {
            const prev = this.stack.pop();
            if (prev) this.screen = prev;
        } else if (action.kind === "tap" || action.kind === "longPress" || action.kind === "type") {
            const el = this.last.find((e) => e.index === action.index);
            if (!el) return fail("That element is not on the screen any more");
            if (action.kind === "type") {
                if (el.field === undefined) return fail("That is not a text field");
                let text = action.text;
                if (text === "{{credentials.password}}") {
                    if (!el.password) return fail("A password can only go into a password field");
                    text = this.opts.credentials?.password ?? "";
                } else if (text === "{{credentials.username}}") text = this.opts.credentials?.username ?? "";
                else if (el.password) return fail("A password field accepts only the password placeholder");
                this.fields[el.field] = text;
                this.realTyped.push({ field: el.field, text });
            } else if (action.kind === "tap") {
                this.tapped.push(el.text || el.desc || el.id || "?");
                if (typeof el.tap === "string") this.goto(el.tap);
                else el.tap?.(this);
            }
        } else if (action.kind === "scroll") {
            this.state.scrolled = ((this.state.scrolled as number | undefined) ?? 0) + 1;
        }
        this.acts.push(action);
        return { ok: true, snapshot: this.snap(o.screenshot === true) };
    }

    async close(): Promise<void> {
        this.closed = true;
    }
}

// ── a small shop app, like the fake adb's `shop` ────────────────────────────

export const SHOP = "com.example.shop";

export interface ShopOptions {
    /** A line of hostile text on the home screen. */
    hostile?: string;
    /** The permission dialog on first start. */
    permission?: boolean;
    /** The user name and password the app accepts. */
    user?: string;
    password?: string;
}

export function shopApp(o: ShopOptions = {}): AppDef {
    const USER = o.user ?? "tester";
    const PASS = o.password ?? "Fake-Pass-1234";
    return {
        pkg: SHOP,
        start: o.permission === false ? "home" : "permission",
        onLaunch: (d) => (o.permission === false || d.state.permissionAnswered ? "home" : "permission"),
        screens: {
            permission: {
                pkg: "com.google.android.permissioncontroller",
                activity: "GrantPermissionsActivity",
                els: () => [
                    { text: "Allow Shop to send you notifications?", id: "permission_message" },
                    { text: "Allow", id: "permission_allow_button", tap: (d) => { d.state.permissionAnswered = true; d.goto("home", false); } },
                    { text: "Don't allow", id: "permission_deny_button", tap: (d) => { d.state.permissionAnswered = true; d.goto("home", false); } },
                ],
            },
            home: {
                activity: "MainActivity",
                els: (d) => [
                    { text: "Shop", id: "toolbar_title" },
                    { field: "search", text: "Search products", id: "search_box" },
                    ...(d.state.loggedIn
                        ? [{ text: `Hello, ${USER}`, id: "welcome" }, { text: "Log out", id: "logout_button", tap: (x: MemoryDevice) => { x.state.loggedIn = false; } }]
                        : [{ text: "Sign in", id: "signin_button", tap: "signin" }]),
                    { text: "Products", id: "products_button", tap: "products" },
                    { cls: "ImageButton", desc: `Cart, ${(d.state.cart as number | undefined) ?? 0} items`, id: "cart_button", tap: "cart" },
                    { text: "Terms and conditions", id: "terms_link", tap: "browser" },
                    { text: "Delete account", id: "delete_account_link", tap: "delete" },
                    ...(o.hostile ? [{ text: o.hostile, id: "note" }] : []),
                ],
            },
            signin: {
                activity: "SignInActivity",
                els: (d) => [
                    { text: "Sign in", id: "title" },
                    { field: "username", text: "Username", id: "username_field" },
                    { field: "password", text: "Password", id: "password_field", password: true },
                    {
                        text: "Log in",
                        id: "login_button",
                        tap: (x) => {
                            if (x.fields.username === USER && x.fields.password === PASS) {
                                x.state.loggedIn = true;
                                x.goto("home", false);
                                x.stack = [];
                            } else x.state.error = "Wrong username or password";
                        },
                    },
                    ...(d.state.error ? [{ text: String(d.state.error), id: "error_text" }] : []),
                ],
            },
            products: {
                activity: "ProductsActivity",
                els: () => [
                    { text: "Products", id: "title" },
                    { cls: "RecyclerView", id: "product_list", scrollable: true },
                    { text: "Product 1", id: "product_1", tap: "product" },
                    { text: "Product 2", id: "product_2", tap: "product" },
                    { text: "Product 3", id: "product_3", tap: "product" },
                ],
            },
            product: {
                activity: "ProductActivity",
                els: () => [
                    { text: "Product details", id: "product_title" },
                    { text: "$9.99", id: "price" },
                    { text: "Add to cart", id: "add_to_cart_button", tap: (d) => { d.state.cart = ((d.state.cart as number | undefined) ?? 0) + 1; d.state.toast = "Added"; } },
                    ...([] as El[]),
                ],
            },
            cart: {
                activity: "CartActivity",
                els: (d) => [
                    { text: "Cart", id: "title" },
                    { text: ((d.state.cart as number | undefined) ?? 0) > 0 ? "Your items" : "Your cart is empty", id: "empty" },
                    { text: "Check out", id: "checkout_button", tap: "payment" },
                ],
            },
            payment: {
                activity: "PaymentActivity",
                els: () => [
                    { text: "Payment", id: "title" },
                    { text: "Card number", id: "card_label" },
                    { text: "Pay now", id: "pay_button", tap: (d) => { d.state.paid = true; } },
                    { text: "Cancel", id: "cancel_button", tap: (d) => { const p = d.stack.pop(); if (p) d.screen = p; } },
                ],
            },
            delete: {
                activity: "DeleteAccountActivity",
                els: () => [
                    { text: "Delete account", id: "title" },
                    { text: "This cannot be undone.", id: "warning" },
                    { text: "Delete my account", id: "confirm_delete_button", tap: (d) => { d.state.deleted = true; } },
                    { text: "Cancel", id: "cancel_button", tap: (d) => { const p = d.stack.pop(); if (p) d.screen = p; } },
                ],
            },
            browser: {
                pkg: "com.android.chrome",
                activity: "Main",
                els: () => [{ text: "Terms and conditions of Shop", id: "page" }],
            },
        },
    };
}

/** The phone a test opens: an opener that always returns the same device (and remembers the options it was asked for). */
export function memoryOpener(make: (opts: OpenDeviceOptions) => MemoryDevice): { open: (opts: OpenDeviceOptions) => Promise<DeviceSession>; opened: OpenDeviceOptions[]; devices: MemoryDevice[] } {
    const opened: OpenDeviceOptions[] = [];
    const devices: MemoryDevice[] = [];
    return {
        opened,
        devices,
        open: async (opts) => {
            opened.push(opts);
            const d = make(opts);
            devices.push(d);
            return d;
        },
    };
}
