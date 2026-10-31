/**
 * Fixture app for the browser / screen-size tests. Two kinds of deliberate differences:
 *  - browser-dependent: "Claim offer" is hidden in Firefox, "Install app" only appears in Chromium-based browsers
 *    (both decided in the page's script from navigator.userAgent, so they hold for any Playwright version);
 *  - responsive: the desktop links are hidden below 600px and a "Menu" button appears instead.
 * What each variant therefore sees (✓ = element present):
 *               firefox  webkit  phone  tablet   (desktop Chrome is the base run: everything is present)
 *   Products link    ✓       ✓      ✗      ✓
 *   Menu button      ✗       ✗      ✓      ✗
 *   Claim offer      ✗       ✓      ✓      ✓
 *   Install app      ✗       ✗      ✓      ✓
 */
import http from "node:http";

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture Shop</title>
<style>
  body { font: 16px sans-serif; margin: 16px; }
  #menu-toggle { display: none; }
  @media (max-width: 599px) { .links { display: none; } #menu-toggle { display: inline-block; } }
</style></head>
<body><main>
<h1>Fixture Shop</h1>
<nav aria-label="Main"><button id="menu-toggle" aria-label="Open menu">Menu</button><span class="links"><a href="/products">Products</a> <a href="/about">About</a></span></nav>
<button id="add">Add to cart</button> <p id="cart">Cart: 0 items</p>
<div id="deals"></div><p id="result" hidden></p>
</main>
<script>
  const ua = navigator.userAgent;
  let n = 0;
  document.getElementById("add").onclick = () => { n++; document.getElementById("cart").textContent = "Cart: " + n + " item" + (n === 1 ? "" : "s"); };
  const deals = document.getElementById("deals");
  if (!/Firefox/.test(ua)) deals.insertAdjacentHTML("beforeend", '<button id="offer">Claim offer</button> ');
  if (/Chrome/.test(ua)) deals.insertAdjacentHTML("beforeend", '<button id="install">Install app</button>');
  document.addEventListener("click", (e) => {
    const say = (t) => { const r = document.getElementById("result"); r.hidden = false; r.textContent = t; };
    if (e.target.id === "offer") say("Offer claimed");
    if (e.target.id === "install") say("Install started");
  });
</script></body></html>`;

export function startVariantsApp(port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        if (req.url?.startsWith("/api/ping")) {
            res.writeHead(200, { "content-type": "application/json" });
            return void res.end(JSON.stringify({ ok: true }));
        }
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(PAGE);
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

const nav = { action: "navigate", url: "/" } as const;
const role = (name: string) => ({ by: "role", role: "button", value: name }) as const;

/** Specs for the fixture. WEB-001..004 are the behaviour matrix; the rest must be skipped or never repeated. */
export const FIXTURE_SPECS = [
    { testId: "WEB-001", title: "Add to cart updates the cart", kind: "web", steps: [nav, { action: "click", locator: role("Add to cart") }, { action: "assert", check: "text", locator: { by: "css", value: "#cart" }, expected: "Cart: 1 item" }] },
    { testId: "WEB-002", title: "Desktop navigation links are visible", kind: "web", steps: [nav, { action: "assert", check: "visible", locator: { by: "role", role: "link", value: "Products" } }] },
    { testId: "WEB-003", title: "A special offer can be claimed", kind: "web", steps: [nav, { action: "click", locator: role("Claim offer") }, { action: "assert", check: "text", locator: { by: "css", value: "#result" }, expected: "Offer claimed" }] },
    { testId: "WEB-004", title: "The app install prompt works", kind: "web", steps: [nav, { action: "click", locator: role("Install app") }, { action: "assert", check: "text", locator: { by: "css", value: "#result" }, expected: "Install started" }] },
    { testId: "WEB-005", title: "Home page has no critical accessibility problems", kind: "web", type: "accessibility", steps: [nav, { action: "assert", check: "a11y", expected: "critical" }] },
    { testId: "WEB-006", title: "Home page looks like its approved screenshot", kind: "web", type: "visual", steps: [nav, { action: "assert", check: "screenshot", expected: 500 }] },
    { testId: "WEB-007", title: "A test that never passes", kind: "web", steps: [nav, { action: "assert", check: "visible", expected: "Text that is not on the page" }] },
    { testId: "API-001", title: "Ping answers", kind: "api", steps: [{ action: "request", method: "GET", path: "/api/ping" }, { action: "assertResponse", check: "status", expected: 200 }] },
] as const;
