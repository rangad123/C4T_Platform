/**
 * Fixture application for the recorder tests. Small pages, each with one thing the recorder must handle:
 *   /          links to the other pages
 *   /login     a form: labelled email field, a password field, "Sign in" (any password of 4+ characters works; goes to /welcome)
 *   /welcome   a heading with a test id and a link to the shop
 *   /shop      button, status text, select, checkbox, coupon form (Enter submits), a list with three "Delete" buttons, a file field
 *   /testid    two buttons with the same name; only one has a test id (and a generated-looking class)
 *   /textonly  a clickable block that has nothing but its text
 *   /newtab    a link that opens a new tab
 *   /redirect  moves to 127.0.0.2 (an address the tests' guard refuses)
 *   /slow      the home page, answered after 3 s
 */
import http from "node:http";

const shell = (title: string, body: string, script = "") => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title></head><body><main>${body}</main>${script ? `<script>${script}</script>` : ""}</body></html>`;

const PAGES: Record<string, string> = {
    "/": shell("Fixture", `<h1>Fixture app</h1><nav><a href="/login">Log in</a> <a href="/shop">Shop</a> <a href="/testid">Test id page</a> <a href="/textonly">Text page</a> <a href="/newtab">New tab page</a></nav>`),
    "/login": shell(
        "Log in",
        `<h1>Log in</h1><form id="f"><p><label for="email">Email</label> <input id="email" name="email" type="email"></p><p><label for="pw">Password</label> <input id="pw" name="pw" type="password"></p><button type="submit">Sign in</button></form><p id="msg" role="alert"></p>`,
        `document.getElementById("f").addEventListener("submit", function (e) { e.preventDefault(); if (document.getElementById("pw").value.length >= 4 && document.getElementById("email").value) location.assign("/welcome"); else document.getElementById("msg").textContent = "Wrong email or password"; });`,
    ),
    "/welcome": shell("Welcome", `<h1 data-testid="welcome">Welcome back</h1><p><a href="/shop">Shop</a></p>`),
    "/shop": shell(
        "Shop",
        `<h1>Shop</h1>
<button id="add">Add to cart</button>
<p id="status" role="status">Nothing in the cart</p>
<p><label for="colour">Colour</label> <select id="colour"><option value="red">Red</option><option value="blue">Blue</option></select></p>
<p><label><input type="checkbox" id="gift"> Gift wrap</label></p>
<form id="coupon"><label for="code">Coupon code</label> <input id="code" type="text"> <span id="applied"></span></form>
<ul id="items"><li>Apple <button class="del">Delete</button></li><li>Pear <button class="del">Delete</button></li><li>Plum <button class="del">Delete</button></li></ul>
<p><label for="file">Attachment</label> <input id="file" type="file"></p>`,
        `var n = 0;
document.getElementById("add").onclick = function () { n++; document.getElementById("status").textContent = "Cart: " + n + " item" + (n === 1 ? "" : "s"); };
document.getElementById("coupon").addEventListener("submit", function (e) { e.preventDefault(); document.getElementById("applied").textContent = "Coupon applied"; });
document.querySelectorAll(".del").forEach(function (b) { b.onclick = function () { b.parentNode.remove(); }; });`,
    ),
    "/testid": shell(
        "Test id",
        `<h1>Test id page</h1><button data-testid="buy-now" class="btn-a8f3k2x1">Buy</button> <button class="other">Buy</button><p id="out" role="status"></p>`,
        `document.querySelector("[data-testid=buy-now]").onclick = function () { document.getElementById("out").textContent = "Bought"; };`,
    ),
    "/textonly": shell(
        "Text only",
        `<h1>Text page</h1><div id="toggle" style="cursor:pointer">Show details</div><div id="details" hidden>These are the details</div><span class="promo">Free shipping on all orders</span>`,
        `document.getElementById("toggle").onclick = function () { document.getElementById("details").hidden = false; };`,
    ),
    "/newtab": shell("New tab", `<h1>New tab page</h1><a href="/shop" target="_blank" rel="opener">Open the shop in a new tab</a>`),
};

export function startRecorderApp(port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const path = (req.url ?? "/").split("?")[0]!;
        if (path === "/redirect") {
            res.writeHead(302, { location: `http://127.0.0.2:${port}/` });
            return void res.end();
        }
        if (path === "/slow") {
            // A start page that is still loading when the person already moves on (the recorder must not fail the session for it).
            const t = setTimeout(() => {
                res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
                res.end(PAGES["/"]);
            }, 3_000);
            res.on("close", () => clearTimeout(t));
            return;
        }
        const page = PAGES[path];
        if (!page) {
            res.writeHead(404, { "content-type": "text/plain" });
            return void res.end("Not found");
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page);
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
