/**
 * Android App Bundles (.aab), honestly.
 *
 * A phone cannot install an .aab: Google Play turns it into APKs. On a computer that has Java and bundletool (Google's own tool, a .jar the owner
 * downloads once; the platform never downloads it), the bundle is turned into ONE universal APK (`bundletool build-apks --mode=universal`) and that APK
 * is used like an uploaded one. Without them the upload is refused with a plain sentence that says what to do. Signing: bundletool signs with the
 * Android debug key of the computer (~/.android/debug.keystore) when there is one, which is what an emulator or a test phone needs.
 */
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { commandFor, taqwrightHome } from "../toolchain.js";

export const AAB_REFUSAL =
    "This is an Android App Bundle (.aab). Upload an .apk, or install Java and bundletool on the computer that runs the platform and set BUNDLETOOL_JAR to the bundletool .jar file, then upload the .aab again.";

/** Largest APK taken out of the converted set. */
const MAX_APK_BYTES = 512 * 1024 * 1024;
const CONVERT_TIMEOUT_MS = 5 * 60_000;

const exe = (n: string) => (process.platform === "win32" ? `${n}.exe` : n);

/** `java`: AITP_JAVA_PATH (a stand-in for tests or an explicit choice), JAVA_HOME, Taqwright's own JDK, then the PATH. */
export function javaPath(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const seam = env.AITP_JAVA_PATH?.trim();
    if (seam) return fs.existsSync(seam) ? path.resolve(seam) : undefined;
    const homes: string[] = [];
    if (env.JAVA_HOME?.trim()) homes.push(env.JAVA_HOME.trim());
    try {
        const m = JSON.parse(fs.readFileSync(path.join(taqwrightHome(env), "manifest.json"), "utf8")) as { javaHome?: string };
        if (m.javaHome) homes.push(m.javaHome);
    } catch {
        /* no managed JDK */
    }
    for (const h of homes) {
        const p = path.join(h, "bin", exe("java"));
        if (fs.existsSync(p) && fs.statSync(p).size > 0) return p;
    }
    for (const dir of (env.PATH ?? env.Path ?? "").split(path.delimiter)) {
        if (!dir) continue;
        const p = path.join(dir, exe("java"));
        if (fs.existsSync(p)) return p;
    }
    return undefined;
}

/** The bundletool .jar: BUNDLETOOL_JAR, or bundletool.jar in Taqwright's folder. */
export function bundletoolJar(env: NodeJS.ProcessEnv = process.env): string | undefined {
    const named = env.BUNDLETOOL_JAR?.trim();
    const candidates = named ? [named] : [path.join(taqwrightHome(env), "bundletool.jar")];
    return candidates.find((p) => /\.jar$/i.test(p) && fs.existsSync(p));
}

/** Can this computer turn a bundle into an APK? The reason when not. */
export function bundleSupport(env: NodeJS.ProcessEnv = process.env): { ok: true; java: string; jar: string } | { ok: false; reason: string } {
    const jar = bundletoolJar(env);
    const java = javaPath(env);
    if (!jar || !java) return { ok: false, reason: AAB_REFUSAL };
    return { ok: true, java, jar };
}

/** An .aab is a zip whose base module carries its manifest under base/manifest/. */
export function looksLikeBundle(data: Buffer): boolean {
    return data.length > 100 && data.readUInt32LE(0) === 0x04034b50 && data.includes("base/manifest/AndroidManifest.xml") && data.includes("BundleConfig.pb");
}

/** Turns `aabFile` into one universal APK written to `apkFile`. Throws an Error with a plain message. */
export async function convertBundle(aabFile: string, apkFile: string, env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const s = bundleSupport(env);
    if (!s.ok) throw new Error(s.reason);
    const work = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-aab-"));
    try {
        const apks = path.join(work, "app.apks");
        const call = commandFor(s.java, ["-jar", s.jar, "build-apks", `--bundle=${aabFile}`, `--output=${apks}`, "--mode=universal", "--overwrite"]);
        await new Promise<void>((resolve, reject) => {
            execFile(call.file, call.args, { timeout: CONVERT_TIMEOUT_MS, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env }, (error, _out, stderr) => {
                if (!error) return resolve();
                const said = String(stderr ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
                reject(new Error(`bundletool could not turn the bundle into an app${said ? `: ${said}` : ""}.`));
            });
        });
        if (!fs.existsSync(apks)) throw new Error("bundletool did not produce an app.");
        const files = unzipSync(new Uint8Array(fs.readFileSync(apks)), { filter: (f) => /(^|\/)universal\.apk$/.test(f.name) && f.originalSize <= MAX_APK_BYTES });
        const universal = Object.values(files)[0];
        if (!universal) throw new Error("bundletool did not produce a universal app.");
        fs.mkdirSync(path.dirname(apkFile), { recursive: true });
        fs.writeFileSync(apkFile, universal);
    } finally {
        fs.rmSync(work, { recursive: true, force: true });
    }
}
