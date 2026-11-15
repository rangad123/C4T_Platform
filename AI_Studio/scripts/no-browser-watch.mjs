// Run a command and fail if any browser process appears under it (Linux and macOS: `ps`), e.g. the fast tier in CI:
//   node scripts/no-browser-watch.mjs -- npm run test:fast
// The fast tier's launch guard (tests/browser-lock.setup.ts) already refuses an in-process Playwright start; this also catches a browser
// started any other way (a child process, a CLI). It looks every 200 ms at the processes descending from the command, by executable name (the kernel's name, cut to 15 characters, or the command's first word).
// Exit code: the command's own, or 1 when a browser appeared (each one is listed), or 2 on a usage error or when it could never read the
// process list (no `ps`, or it always failed): a watch that never looked does not pass.
import { execFileSync, spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Executable names of the browsers Playwright and others start (Chromium, Chrome, headless shell, Firefox, WebKit). */
export const BROWSER_NAME = /^(chrome|chromium|chromium-browser|google-chrome.*|chrome-headless-shell|chrome-headless|headless_shell|chrome_crashpad_handler|chrome_crashpad|firefox|firefox-bin|minibrowser|webkitwebprocess|webkitnetworkprocess|msedge)(\.exe)?$/i;

/** pid -> { ppid, name, args } for every process on the machine. */
function processes() {
    const out = execFileSync("ps", ["-A", "-o", "pid=,ppid=,comm=,args="], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const all = new Map();
    for (const line of out.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/);
        if (m) all.set(Number(m[1]), { ppid: Number(m[2]), name: path.basename(m[3]), args: m[4] });
    }
    return all;
}

/** The browser processes descending from `root`. */
export function browsersUnder(root, all = processes()) {
    const found = [];
    for (const [pid, p] of all) {
        let q = pid;
        for (let hops = 0; q !== root && q > 1 && hops < 100; hops++) q = all.get(q)?.ppid ?? 0;
        if (q !== root || pid === root) continue;
        const exe = path.basename(p.args.split(/\s+/)[0] ?? "");
        if (BROWSER_NAME.test(p.name) || BROWSER_NAME.test(exe)) found.push({ pid, ...p });
    }
    return found;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const argv = process.argv.slice(2);
    if (argv[0] !== "--" || argv.length < 2) {
        console.error("usage: node scripts/no-browser-watch.mjs -- <command> [args...]");
        process.exit(2);
    }
    const child = spawn(argv[1], argv.slice(2), { stdio: "inherit" });
    const seen = new Map();
    let looked = 0;
    let lastError = "";
    const look = () => {
        try {
            for (const b of browsersUnder(child.pid)) if (!seen.has(b.pid)) seen.set(b.pid, b);
            looked++;
        } catch (e) {
            lastError = e instanceof Error ? e.message.split("\n")[0] : String(e); // the next look tries again
        }
    };
    const timer = setInterval(look, 200);
    look();
    child.on("error", (e) => {
        console.error(e);
        process.exit(2);
    });
    child.on("exit", (code, signal) => {
        clearInterval(timer);
        if (seen.size) {
            console.error(`\n[no-browser-watch] ${seen.size} browser process(es) started under a run that must start none:`);
            for (const b of seen.values()) console.error(`  pid ${b.pid} (parent ${b.ppid}): ${b.args.slice(0, 300)}`);
            process.exit(1);
        }
        if (!looked) {
            console.error(`\n[no-browser-watch] could not read the process list (\`ps\`) even once, so it cannot say that no browser started: ${lastError}`);
            process.exit(2);
        }
        console.error("[no-browser-watch] no browser process started under the run.");
        process.exit(code ?? (signal ? 1 : 0));
    });
}
