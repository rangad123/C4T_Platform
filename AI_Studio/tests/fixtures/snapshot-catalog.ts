/**
 * A larger shop page for the smaller-snapshot tests (ports 7310-7329, Builder SNAP): the parts that make a real accessibility snapshot long.
 * A menu hidden from assistive technology, decorative and unnamed images, separators, 40 product cards that all look alike, a long
 * description, a table of 24 orders, a filter form and a footer. Served by a plain Node server; no external resources.
 *
 *   /            the catalog
 *   /?added=N    the same catalog after product N was added to the cart (the cart count and a status message change)
 */
import http from "node:http";

export const CATALOG_PRODUCTS = Array.from({ length: 40 }, (_, i) => ({
    id: i + 1,
    name: ["Trail Backpack", "Insulated Bottle", "Merino Socks", "Headlamp Pro", "Rain Shell", "Camp Mug", "Trekking Poles", "Sleeping Pad"][i % 8] + ` ${Math.floor(i / 8) + 1}`,
    price: 10 + ((i * 7) % 90) + 0.5,
}));

const LONG = "Every item in this catalog is tested on real trails by our staff before it reaches the shelf. ".repeat(6).trim();

export function catalogPage(added?: number): string {
    const cards = CATALOG_PRODUCTS.map(
        (p) => `<article class="card"><img src="data:," alt=""><h3><a href="/product/${p.id}">${p.name}</a></h3><img src="data:,"><p>$${p.price.toFixed(2)}</p><button type="button" data-id="${p.id}">Add to cart</button></article>`,
    ).join("");
    const orders = Array.from({ length: 24 }, (_, i) => `<tr><td>#${1000 + i}</td><td>2026-10-${String((i % 28) + 1).padStart(2, "0")}</td><td>${i % 3 === 0 ? "Shipped" : "Processing"}</td><td><a href="/orders/${1000 + i}">View order ${1000 + i}</a></td></tr>`).join("");
    const count = added ? 1 : 0;
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Catalog · Big Shop</title></head><body>
<header><a href="/"><img src="data:," alt="">Big Shop</a>
<nav aria-label="Main"><a href="/">Home</a> | <a href="/catalog">Catalog</a> | <a href="/cart">Cart (${count})</a> | <a href="/login">Log in</a></nav>
<div aria-hidden="true"><a href="/m">Mobile menu</a><button>Open menu</button></div>
<div style="display:none"><button>Hidden admin</button></div>
</header>
<main><h1>Catalog</h1>
<p id="status" role="status">${added ? `Added product ${added} to the cart` : ""}</p>
<form role="search" aria-label="Filter"><label for="q">Search the catalog</label><input id="q" name="q"><label><input type="checkbox" name="stock"> In stock only</label><button type="submit">Filter</button></form>
<p>${LONG}</p>
<hr>
<section aria-label="Products">${cards}</section>
<hr>
<h2>Your recent orders</h2>
<table><thead><tr><th>Order</th><th>Date</th><th>Status</th><th>Details</th></tr></thead><tbody>${orders}</tbody></table>
</main>
<footer><a href="/about">About</a> · <a href="/help">Help</a> · <a href="/terms">Terms</a><img src="data:," alt=""></footer>
</body></html>`;
}

export function startCatalog(port: number): Promise<http.Server> {
    const server = http.createServer((req, res) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        if (url.pathname !== "/") {
            res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
            res.end("<!doctype html><html lang=\"en\"><head><title>Not found</title></head><body><h1>Not found</h1></body></html>");
            return;
        }
        const added = Number(url.searchParams.get("added")) || undefined;
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        res.end(catalogPage(added));
    });
    return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}
