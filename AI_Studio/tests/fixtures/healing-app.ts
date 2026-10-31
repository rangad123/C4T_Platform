/**
 * Fixture shop for the locator-healing tests. The same page changes between "the spec's recording" and "the run":
 *   original   "Add to cart" button, heading "Welcome back", the cart text updates when the button is pressed
 *   renamed    the button now says "Add to basket" and the heading says "Welcome"; everything else is the same
 *   ambiguous  the button is gone; two "Add to basket" buttons (two products) take its place
 *   broken     the button is unchanged but pressing it no longer updates the cart (a real application defect)
 */
import http from "node:http";

export type ShopMode = "original" | "renamed" | "ambiguous" | "broken";

const page = (mode: ShopMode) => {
    const heading = mode === "original" ? "Welcome back" : "Welcome";
    const buttons =
        mode === "ambiguous"
            ? `<section aria-label="Product one"><h2>Mug</h2><button class="add">Add to basket</button></section>
               <section aria-label="Product two"><h2>Cap</h2><button class="add">Add to basket</button></section>`
            : `<section aria-label="Product"><h2>Mug</h2><button id="add" class="add">${mode === "renamed" ? "Add to basket" : "Add to cart"}</button></section>`;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Fixture Shop</title></head>
<body><main><h1>${heading}</h1>
${buttons}
<button id="wish">Add to wishlist</button>
<p id="cart" role="status">Cart: 0 items</p>
</main>
<script>
  let n = 0;
  for (const b of document.querySelectorAll("button.add")) b.onclick = () => {
    n++;
    if (${mode === "broken" ? "false" : "true"}) document.getElementById("cart").textContent = "Cart: " + n + " item" + (n === 1 ? "" : "s");
  };
</script></body></html>`;
};

export function startHealingApp(port: number): Promise<{ server: http.Server; setMode(m: ShopMode): void }> {
    let mode: ShopMode = "original";
    const server = http.createServer((req, res) => {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(page(mode));
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, setMode: (m) => void (mode = m) })));
}
