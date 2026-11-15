// BenchNotes: a small, dependency-free notes application with roles, used to measure how well AI Studio finds bugs. Not part of the platform.
//   node examples/bench-rbac/server.mjs <port>
// Environment:
//   BENCH_DEFECTS      which behaviours are switched (none | all | comma-separated names). Default none.
//   BENCH_RESET_TOKEN  enables POST /__bench/reset (header x-bench-reset must match); the route is 404 without it.
//   BENCH_LOGIN        html (default): sign-in and registration are plain HTML forms (POST, then a 303 to the next page);
//                      js: the same forms are sent by the page script to the JSON API instead.
// Roles: user (own notes, sharing), manager (also reads every note), admin (also manages people and roles). Data in memory, reset on start.
import http from "node:http";
import { randomBytes } from "node:crypto";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 9465);
const SWITCHES = new Set(
    String(process.env.BENCH_DEFECTS ?? "none")
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s && s !== "none"),
);
const on = (id) => SWITCHES.has("all") || SWITCHES.has(id);
const RESET_TOKEN = process.env.BENCH_RESET_TOKEN ?? "";
const JS_LOGIN = process.env.BENCH_LOGIN === "js";
const ROLES = ["user", "manager", "admin"];
const MIN_PASSWORD = 8;

let db;
function reset() {
    db = {
        users: [
            { id: "u1", email: "ana@example.test", password: "Password1!", name: "Ana Silva", role: "user" },
            { id: "u2", email: "ben@example.test", password: "Password1!", name: "Ben Carter", role: "user" },
            { id: "u3", email: "mia@example.test", password: "Password1!", name: "Mia Novak", role: "manager" },
            { id: "u4", email: "ada@example.test", password: "Password1!", name: "Ada Brooks", role: "admin" },
        ],
        sessions: new Map(),
        notes: [
            { id: "n1", ownerId: "u1", title: "Ana's travel plans", body: "Train to Porto on the 14th.", sharedWith: [] },
            { id: "n2", ownerId: "u2", title: "Ben's salary review", body: "Private: discuss the raise with Mia.", sharedWith: [] },
            { id: "n3", ownerId: "u2", title: "Team lunch ideas", body: "Ramen place near the station.", sharedWith: ["u1"] },
        ],
        nextUser: 5,
        nextNote: 4,
    };
}
reset();

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
/**
 * Standard hardening on every response; the pages keep to it (no inline script, everything from this origin). Inline styles are allowed:
 * the test run itself injects one (screenshots), and a strict style-src would make every page-health check fail on it.
 */
const SECURITY = {
    "content-security-policy": "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'",
    "x-content-type-options": "nosniff",
    "referrer-policy": "strict-origin-when-cross-origin",
    "x-frame-options": "DENY",
    "cross-origin-opener-policy": "same-origin",
    "permissions-policy": "camera=(), microphone=(), geolocation=()",
};
function sendJson(res, status, body, extra = {}) {
    res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...SECURITY, ...extra });
    res.end(JSON.stringify(body));
}
function redirect(res, to) {
    res.writeHead(303, { location: to, ...SECURITY });
    res.end();
}
function cookiesOf(req) {
    const out = {};
    for (const part of String(req.headers.cookie ?? "").split(";")) {
        const i = part.indexOf("=");
        if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}
function userOf(req) {
    const sid = cookiesOf(req).sid;
    const s = sid ? db.sessions.get(sid) : undefined;
    if (!s || (s.ended && !on("BR-05"))) return undefined;
    return db.users.find((u) => u.id === s.userId);
}
async function bodyOf(req) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > 64 * 1024) return {};
        chunks.push(c);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    if (!raw) return {};
    if (String(req.headers["content-type"] ?? "").includes("application/json")) {
        try {
            const v = JSON.parse(raw);
            return v && typeof v === "object" ? v : {};
        } catch {
            return {};
        }
    }
    return Object.fromEntries(new URLSearchParams(raw));
}

/** May this person read the note? The owner, people it is shared with, managers and admins. */
const canRead = (u, n) => n.ownerId === u.id || n.sharedWith.includes(u.id) || u.role === "manager" || u.role === "admin" || on("BR-01");
/** May this person change the note? Only its owner. */
const canWrite = (u, n) => n.ownerId === u.id || on("BR-02");
const visibleTo = (u) => db.notes.filter((n) => n.ownerId === u.id || n.sharedWith.includes(u.id) || u.role === "manager" || u.role === "admin");
const noteView = (n) => ({ id: n.id, title: n.title, body: n.body, owner: db.users.find((u) => u.id === n.ownerId)?.name ?? "", sharedWith: n.sharedWith.map((id) => ({ id, name: db.users.find((u) => u.id === id)?.name ?? "" })) });
const userView = (u) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function session(u) {
    const sid = randomBytes(16).toString("hex");
    db.sessions.set(sid, { userId: u.id, ended: false });
    return `sid=${sid}; Path=/; HttpOnly; SameSite=Lax`;
}
/** Create an account (role user) and sign it in: { user, cookie } or { status, error }. Used by the API and the HTML form alike. */
function register(b) {
    const email = String(b.email ?? "").trim().toLowerCase();
    const password = String(b.password ?? "");
    const name = String(b.name ?? "").trim();
    if (!name) return { status: 400, error: "Enter your name." };
    if (!EMAIL.test(email)) return { status: 400, error: "Enter a valid email address." };
    if (password.length < (on("BR-07") ? 1 : MIN_PASSWORD)) return { status: 400, error: `Use at least ${MIN_PASSWORD} characters for the password.` };
    if (db.users.some((u) => u.email === email)) return { status: 409, error: "An account with this email already exists." };
    const u = { id: `u${db.nextUser++}`, email, password, name, role: "user" };
    db.users.push(u);
    return { user: u, cookie: session(u) };
}
function signIn(b) {
    const u = db.users.find((x) => x.email === String(b.email ?? "").trim().toLowerCase() && x.password === String(b.password ?? ""));
    return u ? { user: u, cookie: session(u) } : { error: "Email or password is wrong." };
}
const safeNext = (next, fallback) => (typeof next === "string" && next.startsWith("/") && !next.startsWith("//") ? next : fallback);

async function api(req, res, url, user) {
    const m = req.method;
    const p = url.pathname;
    const need = () => {
        if (!user) sendJson(res, 401, { error: "Sign in first." });
        return Boolean(user);
    };
    if (p === "/api/register" && m === "POST") {
        const r = register(await bodyOf(req));
        if (r.error) return sendJson(res, r.status, { error: r.error });
        return sendJson(res, 201, userView(r.user), { "set-cookie": r.cookie });
    }
    if (p === "/api/login" && m === "POST") {
        const r = signIn(await bodyOf(req));
        if (r.error) return sendJson(res, 401, { error: r.error });
        return sendJson(res, 200, userView(r.user), { "set-cookie": r.cookie });
    }
    if (p === "/api/logout" && m === "POST") {
        const sid = cookiesOf(req).sid;
        const s = sid ? db.sessions.get(sid) : undefined;
        if (s) s.ended = true;
        return sendJson(res, 200, { ok: true }, { "set-cookie": "sid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0" });
    }
    if (p === "/api/me" && m === "GET") {
        if (!need()) return;
        return sendJson(res, 200, userView(user));
    }
    if (p === "/api/notes") {
        if (!need()) return;
        if (m === "GET") return sendJson(res, 200, { notes: visibleTo(user).map(noteView) });
        if (m === "POST") {
            const b = await bodyOf(req);
            const title = String(b.title ?? "").trim();
            if (!title && !on("BR-08")) return sendJson(res, 400, { error: "Give the note a title." });
            if (title.length > 120) return sendJson(res, 400, { error: "A title is at most 120 characters." });
            const n = { id: `n${db.nextNote++}`, ownerId: user.id, title, body: String(b.body ?? ""), sharedWith: [] };
            db.notes.push(n);
            return sendJson(res, 201, noteView(n));
        }
    }
    let mm = p.match(/^\/api\/notes\/([\w-]+)$/);
    if (mm) {
        if (!need()) return;
        const n = db.notes.find((x) => x.id === mm[1]);
        if (!n || !canRead(user, n)) return sendJson(res, 404, { error: "Note not found." });
        if (m === "GET") return sendJson(res, 200, noteView(n));
        if (m === "PUT") {
            if (!canWrite(user, n)) return sendJson(res, 403, { error: "Only the owner can change this note." });
            const b = await bodyOf(req);
            const title = String(b.title ?? "").trim();
            if (!title) return sendJson(res, 400, { error: "Give the note a title." });
            n.title = title.slice(0, 120);
            n.body = String(b.body ?? "");
            return sendJson(res, 200, noteView(n));
        }
        if (m === "DELETE") {
            if (n.ownerId !== user.id) return sendJson(res, 403, { error: "Only the owner can delete this note." });
            db.notes = db.notes.filter((x) => x !== n);
            return sendJson(res, 200, { ok: true });
        }
    }
    mm = p.match(/^\/api\/notes\/([\w-]+)\/share(?:\/([\w-]+))?$/);
    if (mm) {
        if (!need()) return;
        const n = db.notes.find((x) => x.id === mm[1]);
        if (!n || !canRead(user, n)) return sendJson(res, 404, { error: "Note not found." });
        if (n.ownerId !== user.id) return sendJson(res, 403, { error: "Only the owner can share this note." });
        if (!mm[2] && m === "POST") {
            const b = await bodyOf(req);
            const to = db.users.find((u) => u.email === String(b.email ?? "").trim().toLowerCase());
            if (!to) return sendJson(res, 404, { error: "No one with that email." });
            if (to.id === user.id) return sendJson(res, 400, { error: "You already own this note." });
            if (!n.sharedWith.includes(to.id)) n.sharedWith.push(to.id);
            return sendJson(res, 200, noteView(n));
        }
        if (mm[2] && m === "DELETE") {
            if (!n.sharedWith.includes(mm[2])) return sendJson(res, 404, { error: "Not shared with that person." });
            if (!on("BR-06")) n.sharedWith = n.sharedWith.filter((id) => id !== mm[2]);
            const view = noteView(n);
            view.sharedWith = view.sharedWith.filter((s) => s.id !== mm[2]);
            return sendJson(res, 200, view);
        }
    }
    if (p === "/api/admin/users" && m === "GET") {
        if (!need()) return;
        if (user.role !== "admin" && !on("BR-03")) return sendJson(res, 403, { error: "Only admins can see people." });
        return sendJson(res, 200, { users: db.users.map(userView) });
    }
    mm = p.match(/^\/api\/admin\/users\/([\w-]+)$/);
    if (mm && m === "PATCH") {
        if (!need()) return;
        if (user.role !== "admin" && !(on("BR-04") && user.role === "manager")) return sendJson(res, 403, { error: "Only admins can change roles." });
        const target = db.users.find((u) => u.id === mm[1]);
        if (!target) return sendJson(res, 404, { error: "Person not found." });
        const b = await bodyOf(req);
        const role = String(b.role ?? "");
        if (!ROLES.includes(role)) return sendJson(res, 400, { error: "Choose user, manager or admin." });
        target.role = role;
        return sendJson(res, 200, userView(target));
    }
    return sendJson(res, 404, { error: "Not found." });
}

const NAV = (user) =>
    `<header><a href="/" class="brand">BenchNotes</a><nav aria-label="Main">${
        user
            ? `<a href="/notes">Notes</a> <a href="/notes/new">New note</a>${user.role === "admin" ? ` <a href="/admin/users">People</a>` : ""} <a href="/account">Account</a> <form data-api="/api/logout" data-next="/login" class="inline"><button type="submit">Sign out</button></form>`
            : `<a href="/login">Sign in</a> <a href="/register">Create account</a>`
    }</nav></header>`;
function page(res, title, user, body, status = 200) {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", ...SECURITY });
    res.end(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)} · BenchNotes</title><link rel="stylesheet" href="/styles.css"></head><body>${NAV(user)}<main>${body}</main><script src="/app.js"></script></body></html>`);
}

function loginPage(res, user, next, error = "", email = "", status = 200) {
    const form = JS_LOGIN ? `<form data-api="/api/login" data-next="${esc(next)}">` : `<form method="post" action="/login"><input type="hidden" name="next" value="${esc(next)}">`;
    return page(res, "Sign in", user, `<h1>Sign in</h1>${error ? `<p role="alert">${esc(error)}</p>` : ""}${form}<label>Email <input name="email" type="email" autocomplete="username" value="${esc(email)}" required></label><label>Password <input name="password" type="password" autocomplete="current-password" required></label><button type="submit">Sign in</button></form>`, status);
}
function registerPage(res, user, error = "", values = {}, status = 200) {
    const form = JS_LOGIN ? `<form data-api="/api/register" data-next="/notes" novalidate>` : `<form method="post" action="/register" novalidate>`;
    return page(res, "Create account", user, `<h1>Create an account</h1>${error ? `<p role="alert">${esc(error)}</p>` : ""}${form}<label>Name <input name="name" value="${esc(values.name)}"></label><label>Email <input name="email" value="${esc(values.email)}"></label><label>Password <input name="password" type="password" autocomplete="new-password"></label><p class="hint">Passwords need at least ${MIN_PASSWORD} characters.</p><button type="submit">Create account</button></form>`, status);
}
/** The HTML sign-in and registration forms (BENCH_LOGIN=html): POST, then 303 to the next page with the session cookie, or the form again with the message. */
async function formPosts(req, res, url) {
    const b = await bodyOf(req);
    if (url.pathname === "/login") {
        const r = signIn(b);
        const next = safeNext(b.next, "/notes");
        if (r.error) return loginPage(res, undefined, next, r.error, String(b.email ?? ""), 400);
        res.writeHead(303, { location: next, "set-cookie": r.cookie, ...SECURITY });
        return res.end();
    }
    const r = register(b);
    if (r.error) return registerPage(res, undefined, r.error, { name: String(b.name ?? ""), email: String(b.email ?? "") }, 400);
    res.writeHead(303, { location: "/notes", "set-cookie": r.cookie, ...SECURITY });
    return res.end();
}

function pages(req, res, url, user) {
    const p = url.pathname;
    if (p === "/") return user ? redirect(res, "/notes") : page(res, "Welcome", user, `<h1>BenchNotes</h1><p>Private notes you can share with colleagues. Managers can read every note; only admins manage people and roles.</p><p><a href="/login">Sign in</a> or <a href="/register">create an account</a>.</p>`);
    if (p === "/login") return loginPage(res, user, safeNext(url.searchParams.get("next"), "/notes"));
    if (p === "/register") return registerPage(res, user);
    if (!user) return redirect(res, `/login?next=${encodeURIComponent(p)}`);
    if (p === "/notes") {
        const list = visibleTo(user);
        const items = list.map((n) => `<li><a href="/notes/${n.id}">${esc(n.title || "(untitled)")}</a> <span class="meta">by ${esc(db.users.find((u) => u.id === n.ownerId)?.name)}</span></li>`).join("");
        return page(res, "Notes", user, `<h1>Notes</h1>${list.length ? `<ul>${items}</ul>` : "<p>No notes yet.</p>"}<p><a href="/notes/new">New note</a></p>`);
    }
    if (p === "/notes/new") return page(res, "New note", user, `<h1>New note</h1><form data-api="/api/notes" data-next-from="id" data-next-prefix="/notes/" novalidate><label>Title <input name="title"></label><label>Text <textarea name="body" rows="5"></textarea></label><p class="hint">Every note needs a title.</p><button type="submit">Save note</button></form>`);
    let mm = p.match(/^\/notes\/([\w-]+)$/);
    if (mm) {
        const n = db.notes.find((x) => x.id === mm[1]);
        if (!n || !canRead(user, n)) return page(res, "Note not found", user, `<h1>Note not found</h1><p><a href="/notes">Back to notes</a></p>`, 404);
        const owner = n.ownerId === user.id;
        const shared = n.sharedWith.map((id) => {
            const u = db.users.find((x) => x.id === id);
            return `<li>${esc(u?.name)}${owner ? ` <form data-api="/api/notes/${n.id}/share/${id}" data-method="DELETE" class="inline"><button type="submit">Stop sharing with ${esc(u?.name)}</button></form>` : ""}</li>`;
        });
        const edit = owner
            ? `<h2>Edit</h2><form data-api="/api/notes/${n.id}" data-method="PUT" data-success="Saved."><label>Title <input name="title" value="${esc(n.title)}"></label><label>Text <textarea name="body" rows="5">${esc(n.body)}</textarea></label><button type="submit">Save changes</button></form><h2>Share</h2><form data-api="/api/notes/${n.id}/share"><label>Colleague's email <input name="email"></label><button type="submit">Share</button></form><form data-api="/api/notes/${n.id}" data-method="DELETE" data-next="/notes"><button type="submit">Delete note</button></form>`
            : "";
        return page(res, n.title || "Note", user, `<h1>${esc(n.title || "(untitled)")}</h1><p class="meta">Owner: ${esc(db.users.find((u) => u.id === n.ownerId)?.name)}</p><div class="body">${esc(n.body)}</div><h2>Shared with</h2>${shared.length ? `<ul>${shared.join("")}</ul>` : "<p>Nobody.</p>"}${edit}`);
    }
    if (p === "/admin/users") {
        if (user.role !== "admin") return page(res, "Not allowed", user, `<h1>Not allowed</h1><p>Only admins can manage people.</p>`, 403);
        const rows = db.users.map((u) => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td><form data-api="/api/admin/users/${u.id}" data-method="PATCH" class="inline"><label>Role <select name="role">${ROLES.map((r) => `<option${r === u.role ? " selected" : ""}>${r}</option>`).join("")}</select></label> <button type="submit">Change role</button></form></td></tr>`).join("");
        return page(res, "People", user, `<h1>People</h1><table><caption>Everyone with an account</caption><thead><tr><th scope="col">Name</th><th scope="col">Email</th><th scope="col">Role</th></tr></thead><tbody>${rows}</tbody></table>`);
    }
    if (p === "/account") return page(res, "Account", user, `<h1>Your account</h1><p>${esc(user.name)}, ${esc(user.email)}</p><p>Role: <strong data-testid="role">${user.role}</strong></p>`);
    return page(res, "Not found", user, `<h1>Page not found</h1>`, 404);
}

const APP_JS = `document.addEventListener("submit", async (e) => {
  const f = e.target.closest("form[data-api]");
  if (!f) return;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f));
  let out = f.querySelector("[data-out]");
  if (!out) { out = document.createElement("p"); out.setAttribute("data-out", ""); out.setAttribute("role", "status"); f.appendChild(out); }
  out.textContent = "";
  const res = await fetch(f.dataset.api, { method: f.dataset.method || "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) { out.setAttribute("role", "alert"); out.textContent = body.error || "Something went wrong."; return; }
  if (f.dataset.success) { out.setAttribute("role", "status"); out.textContent = f.dataset.success; return; }
  if (f.dataset.nextFrom) { location.href = f.dataset.nextPrefix + body[f.dataset.nextFrom]; return; }
  if (f.dataset.next) { location.href = f.dataset.next; return; }
  location.reload();
});`;
const STYLES = `body{font-family:system-ui,sans-serif;margin:0;color:#222;background:#fafafa}header{display:flex;gap:1rem;align-items:center;padding:.75rem 1rem;background:#fff;border-bottom:1px solid #ddd}
nav a,nav form{margin-right:.75rem}main{max-width:52rem;margin:1rem auto;padding:0 1rem}label{display:block;margin:.5rem 0}.inline{display:inline}table{border-collapse:collapse;width:100%}
td,th{border-bottom:1px solid #ddd;padding:.4rem;text-align:left}.hint,.meta{color:#555}[role=alert]{color:#a00}.body{white-space:pre-wrap}`;

const OPENAPI = {
    openapi: "3.0.3",
    info: { title: "BenchNotes API", version: "1.0.0", description: "Roles: user (own notes and notes shared with them), manager (reads every note), admin (also manages people and roles)." },
    paths: {
        "/api/register": { post: { summary: "Create an account (valid email, password of at least 8 characters); new accounts are users", responses: { 201: { description: "Created and signed in" }, 400: { description: "Invalid input" }, 409: { description: "Email already used" } } } },
        "/api/login": { post: { summary: "Sign in", responses: { 200: { description: "Signed in" }, 401: { description: "Wrong email or password" } } } },
        "/api/logout": { post: { summary: "Sign out; the session stops working", responses: { 200: { description: "Signed out" } } } },
        "/api/me": { get: { summary: "Who is signed in", responses: { 200: { description: "Person" }, 401: { description: "Not signed in" } } } },
        "/api/notes": { get: { summary: "Notes you may read", responses: { 200: { description: "Notes" } } }, post: { summary: "Create a note (title required, at most 120 characters)", requestBody: { content: { "application/json": { schema: { type: "object", required: ["title"], properties: { title: { type: "string", minLength: 1, maxLength: 120 }, body: { type: "string" } } } } } }, responses: { 201: { description: "Created" }, 400: { description: "Missing title" } } } },
        "/api/notes/{id}": { get: { summary: "Read a note (owner, people it is shared with, managers, admins)", responses: { 200: { description: "Note" }, 404: { description: "Not found or not visible to you" } } }, put: { summary: "Change a note (owner only)", responses: { 200: { description: "Changed" }, 403: { description: "Not the owner" }, 404: { description: "Not found" } } }, delete: { summary: "Delete a note (owner only)", responses: { 200: { description: "Deleted" }, 403: { description: "Not the owner" } } } },
        "/api/notes/{id}/share": { post: { summary: "Share a note with a colleague by email (owner only)", responses: { 200: { description: "Shared" }, 404: { description: "No such person" } } } },
        "/api/notes/{id}/share/{userId}": { delete: { summary: "Stop sharing (owner only); that person can no longer read the note", responses: { 200: { description: "No longer shared" } } } },
        "/api/admin/users": { get: { summary: "Everyone with an account (admins only)", responses: { 200: { description: "People" }, 403: { description: "Not an admin" } } } },
        "/api/admin/users/{id}": { patch: { summary: "Change someone's role (admins only)", responses: { 200: { description: "Changed" }, 403: { description: "Not an admin" } } } },
    },
};

const server = http.createServer(async (req, res) => {
    try {
        const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
        if (url.pathname === "/__bench/reset") {
            if (!RESET_TOKEN) return sendJson(res, 404, { error: "Not found." });
            if (req.method !== "POST" || req.headers["x-bench-reset"] !== RESET_TOKEN) return sendJson(res, 403, { error: "Forbidden." });
            reset();
            return sendJson(res, 200, { ok: true });
        }
        if (url.pathname === "/app.js") {
            res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", ...SECURITY });
            return res.end(APP_JS);
        }
        if (url.pathname === "/styles.css") {
            res.writeHead(200, { "content-type": "text/css; charset=utf-8", ...SECURITY });
            return res.end(STYLES);
        }
        if (url.pathname === "/openapi.json") return sendJson(res, 200, OPENAPI);
        const user = userOf(req);
        if (url.pathname.startsWith("/api/")) return await api(req, res, url, user);
        if (req.method === "POST" && !JS_LOGIN && (url.pathname === "/login" || url.pathname === "/register")) return await formPosts(req, res, url);
        if (req.method !== "GET" && req.method !== "HEAD") return sendJson(res, 405, { error: "Method not allowed." });
        return pages(req, res, url, user);
    } catch {
        if (!res.headersSent) sendJson(res, 500, { error: "Something went wrong." });
        else res.end();
    }
});
server.listen(PORT, "127.0.0.1");
