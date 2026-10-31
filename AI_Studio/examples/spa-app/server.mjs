// SpaMail: a tiny dependency-free single-page app used to test client-side route discovery.
// Not part of the platform itself.
//   node examples/spa-app/server.mjs [port]      (default 5090)
//
// Routing mix, on purpose:
//   #/inbox, #/inbox/42, #!/archive  hash routes (no server involvement)
//   /about                           pushState link; the server also serves the shell here
//   /reports                         pushState link; the server 404s a direct GET (static-host style)
//   /settings                        pushState from a <button> (no href at all); server 404s too
//   #features                        plain in-page anchor, must NOT become a page
//   #/logout, "Delete account"       destructive, must never be followed or clicked
import http from "node:http";

const PORT = Number(process.argv[2] ?? process.env.PORT ?? 5090);

const SHELL = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>SpaMail</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{font-family:system-ui,sans-serif;margin:0}header{background:#1e3a8a;color:#fff;padding:12px 24px}
nav{display:flex;gap:14px;flex-wrap:wrap;align-items:center}nav a{color:#fff}main{padding:24px}#features{margin-top:600px}</style></head>
<body><header><strong>SpaMail</strong>
<nav aria-label="Main">
<a href="#/inbox">Inbox</a>
<a href="#/inbox/42">Message 42</a>
<a href="#!/archive">Archive</a>
<a href="#features">Features</a>
<a href="/about" data-spa>About</a>
<a href="/reports" data-spa>Reports</a>
<button type="button" data-to="/settings">Settings</button>
<button type="button" data-to="/danger-zone">Delete account</button>
<a href="#/logout">Log out</a>
</nav></header>
<main id="view"></main>
<section id="features"><h2>Features</h2><p>Hash and history routing.</p></section>
<script>
const VIEWS = {
    "/": ["Home", "Welcome to SpaMail."],
    "#/inbox": ["Inbox", "You have 1 message."],
    "#/inbox/42": ["Message 42", "Hello from message 42."],
    "#!/archive": ["Archive", "Nothing archived."],
    "#/logout": ["Logged out", "You have been logged out."],
    "/about": ["About", "SpaMail is a demo."],
    "/reports": ["Reports", "Monthly reports."],
    "/settings": ["Settings", "Notification settings."],
    "/danger-zone": ["Account deleted", "This should never be reached by the crawler."],
};
function render() {
    const route = /^#!?\\//.test(location.hash) ? location.hash : "";
    const key = route && route !== "#/" ? route : location.pathname;
    const [h, p] = VIEWS[key] ?? ["Not found", "Unknown view " + key];
    document.title = h + " · SpaMail";
    document.getElementById("view").innerHTML = "<h1>" + h + "</h1><p>" + p + "</p>";
}
function go(path) {
    history.pushState({}, "", path);
    render();
}
document.addEventListener("click", (e) => {
    const a = e.target.closest("a[data-spa]");
    if (a) {
        e.preventDefault();
        go(a.getAttribute("href"));
        return;
    }
    const b = e.target.closest("button[data-to]");
    if (b) go(b.dataset.to);
});
addEventListener("popstate", render);
addEventListener("hashchange", render);
render();
</script>
</body></html>`;

http.createServer((req, res) => {
    const { pathname } = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
    // Only "/" and "/about" get the app shell; other client-side routes 404 like a static host would.
    if (pathname === "/" || pathname === "/about") {
        res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
        return res.end(SHELL);
    }
    res.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    res.end("<!doctype html><title>404</title><h1>404 Not Found</h1>");
}).listen(PORT, "127.0.0.1", () => console.log(`SpaMail on http://127.0.0.1:${PORT}`));
