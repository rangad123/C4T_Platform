/**
 * The two local fixtures of the corpus, so the harness can be checked end to end without any outside site, phone or account:
 *
 *   sample-app  the DemoShop sample website (examples/sample-app/server.mjs), started on 127.0.0.1 for the run and stopped after it;
 *   fake-shop   the mock shop app on the fake adb (tests/fixtures/fake-adb.mjs) with the Taqwright stand-in: no emulator, no phone,
 *               no adb server. Only with a platform the harness starts itself, because the fake phone is set up through this process's
 *               environment (a running platform would use its own phone setup).
 *
 * Only the child process started here is ever stopped (by its own handle). The environment is put back as it was afterwards.
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../config.js";
import type { Corpus, CorpusEntry } from "./corpus.js";

/** The sample site's demo account and the fake shop app's account: fixture values that are in the repository, not secrets. */
const SAMPLE_ACCOUNT = { username: "demo@example.com", password: "Password123!", apiToken: "demo-token-123" };
const SHOP_ACCOUNT = { username: "tester", password: "Fake-Pass-1234" };
export const FAKE_SHOP_PACKAGE = "com.example.shop";

export type Resolved = { url?: string; appPackage?: string; credentials?: Record<string, string> } | { skip: string };

const freePort = (): Promise<number> =>
    new Promise((resolve, reject) => {
        const s = net.createServer();
        s.once("error", reject);
        s.listen(0, "127.0.0.1", () => {
            const port = (s.address() as net.AddressInfo).port;
            s.close(() => resolve(port));
        });
    });

const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

export class FixtureHost {
    private sample?: ChildProcess;
    private sampleUrl?: string;
    private phoneReady = false;
    private tmp?: string;
    private readonly saved: Record<string, string | undefined> = {};

    constructor(private readonly o: { mode: "in-process" | "remote"; samplePort?: number }) {}

    private setEnv(e: Record<string, string>): void {
        for (const [k, v] of Object.entries(e)) {
            if (!(k in this.saved)) this.saved[k] = process.env[k];
            process.env[k] = v;
        }
    }

    /** Everything the corpus's fixtures need, before the platform is started (the fake phone is read from the environment). */
    async prepare(corpus: Corpus): Promise<void> {
        const wanted = new Set(corpus.entries.map((e) => e.fixture).filter(Boolean));
        if (wanted.has("fake-shop") && this.o.mode === "in-process") this.preparePhone();
        if (wanted.has("sample-app")) await this.startSample();
    }

    /** A fake Android toolchain in a temporary folder, the fake adb with the shop app, and the Taqwright stand-in to run the tests. */
    private preparePhone(): void {
        const root = (this.tmp ??= fs.mkdtempSync(path.join(os.tmpdir(), "aitp-eval-")));
        fs.mkdirSync(path.join(root, "sdk/platform-tools"), { recursive: true });
        fs.mkdirSync(path.join(root, "jdk/bin"), { recursive: true });
        fs.writeFileSync(path.join(root, "sdk/platform-tools", exe("adb")), "");
        fs.writeFileSync(path.join(root, "jdk/bin", exe("java")), "");
        fs.mkdirSync(path.join(root, "home"), { recursive: true });
        fs.writeFileSync(path.join(root, "home/manifest.json"), JSON.stringify({ androidHome: path.join(root, "sdk"), javaHome: path.join(root, "jdk") }));
        fs.mkdirSync(path.join(root, "avd"), { recursive: true });
        fs.writeFileSync(path.join(root, "avd/Pixel_Test.ini"), "target=android-34\n");
        this.setEnv({
            TAQWRIGHT_HOME: path.join(root, "home"),
            ANDROID_AVD_HOME: path.join(root, "avd"),
            ANDROID_HOME: "",
            MOBILE_RUNNER_CLI: path.join(REPO_ROOT, "tests/fixtures/fake-taqwright.mjs"),
            AITP_ADB_PATH: path.join(REPO_ROOT, "tests/fixtures/fake-adb.mjs"),
            AITP_FAKE_APP: "shop",
            AITP_FAKE_DEVICES: "emulator",
            AITP_FAKE_STATE: path.join(root, "phone-state.json"),
            // The fake emulator is never shut down between runs (there is nothing to shut down).
            MOBILE_KEEP_EMULATOR: "true",
        });
        this.phoneReady = true;
    }

    private async startSample(): Promise<void> {
        const port = this.o.samplePort || (await freePort());
        const child = spawn(process.execPath, [path.join(REPO_ROOT, "examples/sample-app/server.mjs"), String(port)], { stdio: "ignore" });
        this.sample = child;
        const url = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 60; i++) {
            if (child.exitCode !== null) throw new Error(`The sample site could not start on port ${port} (is the port in use?)`);
            try {
                if ((await fetch(url)).ok) {
                    this.sampleUrl = url;
                    return;
                }
            } catch {
                /* not listening yet */
            }
            await new Promise((r) => setTimeout(r, 150));
        }
        throw new Error(`The sample site did not answer on ${url}`);
    }

    /** The address, package and sign-in details a fixture entry uses, or why it cannot run here. Entries without a fixture are returned as they are. */
    resolve(e: CorpusEntry): Resolved {
        if (e.fixture === "sample-app") return this.sampleUrl ? { url: this.sampleUrl, credentials: SAMPLE_ACCOUNT } : { skip: "The sample site is not running." };
        if (e.fixture === "fake-shop") {
            if (this.o.mode !== "in-process") return { skip: "The fake-shop fixture needs the platform the harness starts itself (leave AITP_EVAL_URL unset)." };
            if (!this.phoneReady) return { skip: "The fake phone was not prepared." };
            // A fresh app every time: the state of the mock shop lives in a file.
            fs.rmSync(process.env.AITP_FAKE_STATE!, { force: true });
            return { appPackage: e.appPackage ?? FAKE_SHOP_PACKAGE, credentials: SHOP_ACCOUNT };
        }
        return {};
    }

    async close(): Promise<void> {
        const child = this.sample;
        this.sample = undefined;
        if (child && child.exitCode === null) {
            const gone = new Promise((r) => child.once("exit", r));
            child.kill();
            await Promise.race([gone, new Promise((r) => setTimeout(r, 3000))]);
        }
        for (const [k, v] of Object.entries(this.saved)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
        if (this.tmp) fs.rmSync(this.tmp, { recursive: true, force: true });
    }
}
