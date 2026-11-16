// An app whose one email field tries every way out of the browser when typed into: storage that later pages send, cookies, a
// BroadcastChannel to other tabs, dedicated and shared workers (with their own fetches and WebSockets), WebSockets, EventSource, style
// sheets, fonts, prefetch, iframes, a form in a shadow root, sendBeacon and WebRTC. Every request, WebSocket message and UDP packet
// carrying the typed value is recorded. Loopback only.
//   node tests/fixtures/egress-app.mjs <port>      (UDP on port + 1)
//   /__hits   what reached the server with the typed value in it
import http from "node:http";
import dgram from "node:dgram";
import { createHash } from "node:crypto";
const port = Number(process.argv[2]);
const udpPort = port + 1;
const hits = [];
const NEEDLE = /not-an-email|not%2Dan%2Demail|bm90LWFuLWVtYWls/i;
const note = (channel, text) => { if (NEEDLE.test(text)) hits.push({ channel, at: Date.now(), text: text.slice(0, 200) }); };

const SCRIPT = `
const v = () => document.getElementById("em").value;
// pre-existing long-lived channels opened on load (each on its own: a browser without one must not stop the rest)
let ws; try { ws = new WebSocket("ws://" + location.host + "/ws-page"); } catch (e) {}
let bc; try { bc = new BroadcastChannel("cp4"); } catch (e) {}
let worker; try { worker = new Worker("/worker.js"); } catch (e) {}
let shared; try { shared = new SharedWorker("/shared.js", "cp4"); shared.port.start(); } catch (e) {}
// on every load: report storage-held drafts
const ls = localStorage.getItem("draft"); if (ls) fetch("/leak/localstorage?v=" + encodeURIComponent(ls));
const ss = sessionStorage.getItem("draft"); if (ss) fetch("/leak/sessionstorage?v=" + encodeURIComponent(ss));
try { const req = indexedDB.open("cp4", 1); req.onupgradeneeded = () => req.result.createObjectStore("d"); req.onsuccess = () => { const tx = req.result.transaction("d"); const g = tx.objectStore("d").get("draft"); g.onsuccess = () => { if (g.result) fetch("/leak/indexeddb?v=" + encodeURIComponent(g.result)); }; }; } catch (e) {}
if (bc) bc.onmessage = (e) => { try { ws.send("bc-ws:" + e.data); } catch (x) {} setTimeout(() => fetch("/leak/bc-delayed?v=" + encodeURIComponent(e.data)).catch(() => {}), 1500); };
document.getElementById("em").addEventListener("input", () => {
  const x = v(); if (!x) return;
  localStorage.setItem("draft", x);
  sessionStorage.setItem("draft", x);
  document.cookie = "draft=" + encodeURIComponent(x) + "; path=/";
  try { const req = indexedDB.open("cp4", 1); req.onsuccess = () => req.result.transaction("d", "readwrite").objectStore("d").put(x, "draft"); } catch (e) {}
  try { bc.postMessage(x); } catch (e) {}
  try { worker.postMessage(x); } catch (e) {}
  try { const f = document.createElement("iframe"); document.body.append(f); const s = new f.contentWindow.WebSocket("ws://" + location.host + "/ws-frame"); s.onopen = () => s.send("frame:" + x); } catch (e) {}
  try { shared.port.postMessage(x); } catch (e) {}
  try { new EventSource("/leak/eventsource?v=" + encodeURIComponent(x)); } catch (e) {}
  try { const l = document.createElement("link"); l.rel = "stylesheet"; l.href = "/leak/link-css?v=" + encodeURIComponent(x); document.head.append(l); } catch (e) {}
  try { const s = document.createElement("style"); s.textContent = "@import url('/leak/css-import?v=" + encodeURIComponent(x) + "'); body{background:url('/leak/css-bg?v=" + encodeURIComponent(x) + "')}"; document.head.append(s); } catch (e) {}
  try { new FontFace("f", "url(/leak/font?v=" + encodeURIComponent(x) + ")").load().catch(() => {}); } catch (e) {}
  try { const l = document.createElement("link"); l.rel = "prefetch"; l.href = "/leak/prefetch?v=" + encodeURIComponent(x); document.head.append(l); } catch (e) {}
  try { const l = document.createElement("link"); l.rel = "dns-prefetch"; l.href = "//" + encodeURIComponent(x) + ".localhost"; document.head.append(l); } catch (e) {}
  try { const f = document.createElement("iframe"); f.src = "about:blank"; document.body.append(f); f.contentWindow.fetch("/leak/aboutblank?v=" + encodeURIComponent(x)).catch(() => {}); } catch (e) {}
  try { const f = document.createElement("iframe"); f.srcdoc = "<script>fetch('/leak/srcdoc?v=" + encodeURIComponent(x) + "')<\\/script>"; document.body.append(f); } catch (e) {}
  try { const host = document.createElement("div"); document.body.append(host); const root = host.attachShadow({ mode: "open" }); root.innerHTML = '<form method="post" action="/leak/shadow-form"><input name="v"></form>'; root.querySelector("input").value = x; root.querySelector("form").submit(); } catch (e) {}
  try { navigator.sendBeacon("/leak/beacon", x); } catch (e) {}
  try { const pc = new RTCPeerConnection({ iceServers: [{ urls: "stun:127.0.0.1:${udpPort}", username: x, credential: x }, { urls: "turn:127.0.0.1:${udpPort}?transport=udp", username: x, credential: x }] }); pc.createDataChannel(x); pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => {}); } catch (e) {}
});
`;
const WORKER = `onmessage = (e) => { const x = e.data;
  fetch("/leak/worker-fetch?v=" + encodeURIComponent(x)).catch(() => {});
  try { navigator.sendBeacon && navigator.sendBeacon("/leak/worker-beacon", x); } catch (z) {}
  try { const w = new WebSocket("ws://" + location.host + "/ws-worker-new"); w.onopen = () => w.send("worker-new:" + x); } catch (z) {}
  try { wsw.send("worker-old:" + x); } catch (z) {}
  setTimeout(() => fetch("/leak/worker-delayed?v=" + encodeURIComponent(x)).catch(() => {}), 1200);
};
const wsw = new WebSocket("ws://" + location.host + "/ws-worker-old");`;
const SHARED = `const ports = []; onconnect = (e) => { const p = e.ports[0]; ports.push(p); p.onmessage = (m) => { const x = m.data;
  fetch("/leak/shared-fetch?v=" + encodeURIComponent(x)).catch(() => {});
  try { sws.send("shared-old:" + x); } catch (z) {}
  try { const w = new WebSocket("ws://" + location.host + "/ws-shared-new"); w.onopen = () => w.send("shared-new:" + x); } catch (z) {}
  setTimeout(() => fetch("/leak/shared-delayed?v=" + encodeURIComponent(x)).catch(() => {}), 1500);
  setTimeout(() => fetch("/leak/shared-delayed4?v=" + encodeURIComponent(x)).catch(() => {}), 4000);
}; p.start(); };
const sws = new WebSocket("ws://" + location.host + "/ws-shared-old");`;

const page = (title, body) => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body><h1>${title}</h1>
<nav><a href="/">Home</a> <a href="/next">Next</a> <a href="/third">Third</a></nav>${body}<script>${SCRIPT}</script></body></html>`;
const FORM = `<form id="contact" action="/never" method="post"><label>Email <input id="em" type="email" name="email" required></label></form>`;

const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
        note(`http ${req.method} ${req.url.split("?")[0]}`, `${req.url}\n${JSON.stringify(req.headers)}\n${body}`);
        const u = new URL(req.url, "http://x");
        if (u.pathname === "/__hits") { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(hits)); }
        if (u.pathname === "/worker.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(WORKER); }
        if (u.pathname === "/shared.js") { res.writeHead(200, { "content-type": "text/javascript" }); return res.end(SHARED); }
        if (u.pathname === "/") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page("Contact", FORM)); }
        if (u.pathname === "/next" || u.pathname === "/third") { res.writeHead(200, { "content-type": "text/html" }); return res.end(page("Next " + u.pathname, "<p>hello</p>")); }
        if (u.pathname.startsWith("/leak/eventsource")) { res.writeHead(200, { "content-type": "text/event-stream" }); return res.end("data: x\n\n"); }
        res.writeHead(204); res.end();
    });
});
// A bare WebSocket endpoint on every path: the handshake, then every text frame is checked.
server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (!key) return socket.destroy();
    const accept = createHash("sha1").update(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").digest("base64");
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    let buf = Buffer.alloc(0);
    socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        while (buf.length >= 6) {
            const opcode = buf[0] & 0x0f;
            let len = buf[1] & 0x7f;
            let at = 2;
            if (len === 126) {
                len = buf.readUInt16BE(2);
                at = 4;
            }
            if (buf.length < at + 4 + len) return;
            const mask = buf.subarray(at, at + 4);
            const data = Buffer.from(buf.subarray(at + 4, at + 4 + len).map((b, i) => b ^ mask[i % 4]));
            buf = buf.subarray(at + 4 + len);
            if (opcode === 1) note(`ws ${req.url}`, data.toString("utf8"));
            if (opcode === 8) return socket.end();
        }
    });
    socket.on("error", () => undefined);
});
const udp = dgram.createSocket("udp4");
udp.on("message", (m) => note("udp stun/turn", m.toString("latin1")));
udp.bind(udpPort, "127.0.0.1");
server.listen(port, "127.0.0.1");
