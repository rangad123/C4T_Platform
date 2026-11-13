// The Mac download as a person gets it (round 55): ai-testing-runner-mac.pkg installed by macOS's own Installer, on a real Mac (CI).
//   node scripts/smoke-mac-pkg.mjs [--port 6960] [--out <dir>]
//
// 1. Starts the platform (src/main.ts, runners mode) on a new data folder and signs up its first person, as scripts/smoke-runner.mjs does.
// 2. Downloads that person's Mac runner (POST /api/me/runner/download, this Mac's processor): it must be the package.
// 3. pkgutil --expand must accept it (Apple's own reader of the format the server writes without Apple's tools).
// 4. installer -pkg <file> -target CurrentUserHomeDirectory, as this user, no sudo: the postinstall sets up the runner, which must
//    write "Connected to the platform" to its own log and show as online in Settings, Your runner.
// 5. A second download installed the same way while the runner runs: the earlier runner stops, the new one comes online.
// 6. Removes the computer, uninstalls with the app's own --uninstall (from ~/Applications), and checks the install folder and the
//    LaunchAgent are gone.
// It changes this user's home folder (the real install places), so it runs only on CI's throwaway Macs: it refuses to run unless CI is set.
// Stops only what it started (the platform, by its process group). Exit code: 0 passed, 1 failed.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Children, hostTarget, kitRequestBody, platformEnv, REPO, signUpFirstOwner } from "./smoke-runner.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const arg = (name, fallback) => {
    const i = process.argv.indexOf(name);
    return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const port = Number(arg("--port", "6960"));
const out = path.resolve(arg("--out", path.join(REPO, "smoke-report", "mac-pkg")));
const base = `http://127.0.0.1:${port}`;
const HOME = os.homedir();
const INSTALL = path.join(HOME, "Library", "Application Support", "AITestingRunner");
const RUNLOG = path.join(INSTALL, "logs", "runner.log");
const AGENT = path.join(HOME, "Library", "LaunchAgents", "app.aitesting.runner.plist");
const APP = path.join(HOME, "Applications", "AI Testing Runner.app");

async function until(what, probe, ms, every = 2000) {
    const end = Date.now() + ms;
    for (;;) {
        const v = await probe();
        if (v) return v;
        if (Date.now() > end) throw new Error(`Timed out after ${Math.round(ms / 1000)} s waiting for ${what}.`);
        await sleep(every);
    }
}

async function main() {
    if (process.platform !== "darwin" || !process.env.CI) throw new Error("This check installs into this user's home folder: it runs only on a CI Mac (CI set, macOS).");
    fs.mkdirSync(out, { recursive: true });
    const lines = [];
    const say = (l) => {
        lines.push(l);
        console.log(l);
    };
    const children = new Children();
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-pkg-"));
    const apiKey = `smoke-${randomBytes(18).toString("hex")}`;
    const secrets = [apiKey];
    try {
        const env = platformEnv(process.env, { dataDir: path.join(tmp, "data"), apiKey, port });
        const platform = children.start("platform", process.execPath, [path.join(REPO, "node_modules", "tsx", "dist", "cli.mjs"), path.join("src", "main.ts")], { cwd: REPO, env });
        await until("the platform to answer", () => fetch(`${base}/api/health`).then((r) => r.ok, () => false), 180_000, 500);
        const token = await signUpFirstOwner(base, apiKey, `Smoke-${randomBytes(12).toString("hex")}-Pw`);
        secrets.push(token);
        const auth = { authorization: `Bearer ${token}` };
        const myRunner = async () => {
            const r = (await (await fetch(`${base}/api/me/runner`, { headers: auth })).json()).runner;
            return r && (r.status === "online" || r.status === "busy") ? r : undefined;
        };
        const target = hostTarget();

        const download = async (n) => {
            const res = await fetch(`${base}/api/me/runner/download`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify(kitRequestBody(target)) });
            const buf = Buffer.from(await res.arrayBuffer());
            if (res.status !== 200) throw new Error(`The download was refused (${res.status}): ${buf.toString("utf8").slice(0, 300)}`);
            const name = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1];
            if (name !== "ai-testing-runner-mac.pkg") throw new Error(`The Mac download is ${name}, not the package. ${res.headers.get("x-runner-kit-note") ?? ""}`);
            if (Number(res.headers.get("content-length")) !== buf.length) throw new Error("The Content-Length does not match the bytes.");
            const dir = path.join(tmp, "Downloads", `download ${n}`);
            fs.mkdirSync(dir, { recursive: true });
            const file = path.join(dir, name);
            fs.writeFileSync(file, buf);
            say(`ok    download ${n}: ${name}, ${(buf.length / 1048576).toFixed(1)} MB, ${res.headers.get("x-runner-kit-target") ?? "plain files"}`);
            return file;
        };
        const install = (file) => {
            const r = spawnSync("installer", ["-pkg", file, "-target", "CurrentUserHomeDirectory", "-verboseR"], { encoding: "utf8", timeout: 900_000 });
            fs.appendFileSync(path.join(out, "installer.log"), `${r.stdout ?? ""}${r.stderr ?? ""}\n`);
            if (r.status !== 0) throw new Error(`installer ended with code ${r.status}: ${`${r.stdout ?? ""}${r.stderr ?? ""}`.slice(-600)}`);
        };

        const first = await download(1);
        const expanded = path.join(tmp, "expanded");
        const ex = spawnSync("pkgutil", ["--expand", first, expanded], { encoding: "utf8" });
        if (ex.status !== 0) throw new Error(`pkgutil --expand refused the package: ${ex.stderr}`);
        for (const f of ["Distribution", "runner.pkg/PackageInfo", "runner.pkg/Scripts/postinstall", "runner.pkg/Scripts/kit.zip", "runner.pkg/Scripts/runner.enroll"]) {
            if (!fs.existsSync(path.join(expanded, f))) throw new Error(`pkgutil --expand made no ${f}.`);
        }
        say("ok    pkgutil --expand accepts it (Distribution, PackageInfo, the scripts)");

        const t0 = Date.now();
        install(first);
        say(`ok    installer -pkg ... -target CurrentUserHomeDirectory (${Math.round((Date.now() - t0) / 1000)} s, no sudo)`);
        await until("the runner's own log to say it is connected", () => fs.existsSync(RUNLOG) && fs.readFileSync(RUNLOG, "utf8").includes("Connected to the platform"), 300_000);
        const one = await until("the runner to be online in Settings, Your runner", myRunner, 120_000);
        if (!fs.existsSync(AGENT)) throw new Error("No LaunchAgent was set up (sign-in start).");
        if (!fs.existsSync(path.join(APP, "Contents", "Resources", "runner-setup.sh")) || fs.existsSync(path.join(APP, "Contents", "Resources", "kit"))) throw new Error("~/Applications does not hold the app without a kit.");
        if (fs.existsSync(path.join(INSTALL, "runner", "runner.enroll"))) throw new Error("The one-time code is still in the install folder after the runner connected.");
        say(`ok    connected: "Connected to the platform" in its log, online as ${one.name}, LaunchAgent set up, the app in ~/Applications`);

        const second = await download(2);
        install(second);
        const two = await until("the second package's runner to be online", async () => {
            const r = await myRunner();
            return r && r.id !== one.id ? r : undefined;
        }, 300_000);
        say(`ok    a second package replaced the running runner: online as ${two.id === one.id ? "the same" : "a new"} runner`);

        const retire = await fetch(`${base}/api/me/runner/retire`, { method: "POST", headers: auth });
        if (retire.status !== 200) throw new Error(`Removing the computer failed (${retire.status}).`);
        const un = spawnSync("sh", [path.join(APP, "Contents", "Resources", "runner-setup.sh"), "--uninstall", "--silent"], { encoding: "utf8", timeout: 120_000 });
        if (un.status !== 0) throw new Error(`--uninstall ended with code ${un.status}: ${`${un.stdout}${un.stderr}`.slice(-400)}`);
        await until("the install folder and the LaunchAgent to be gone", () => !fs.existsSync(INSTALL) && !fs.existsSync(AGENT), 30_000, 1000);
        fs.rmSync(APP, { recursive: true, force: true });
        say("ok    removed and uninstalled: no install folder, no LaunchAgent");
        if (!Children.running(platform)) throw new Error("The platform stopped during the check.");
        say("Mac package check passed.");
    } finally {
        await children.stopAll();
        const platformOut = children.list.map((c) => `== ${c.name}\n${c.output}`).join("\n");
        fs.writeFileSync(path.join(out, "platform.log"), secrets.reduce((t, s) => t.split(s).join("[removed]"), platformOut));
        fs.writeFileSync(path.join(out, "report.txt"), `${lines.join("\n")}\n`);
        fs.rmSync(tmp, { recursive: true, force: true });
    }
}

main().catch((e) => {
    console.error(`FAIL  ${e?.message ?? e}`);
    process.exit(1);
});
