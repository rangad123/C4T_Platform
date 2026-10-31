/**
 * The TEST-ONLY certificates of tests/fixtures/tls. Their private keys (*.key) are not in the repository (the repository ignores every key),
 * so a fresh checkout has the certificates and no keys. Then a matching set is made here with openssl, the way the README in
 * tests/fixtures/tls/company says it was made; without openssl the tests that need one are skipped and say why (TLS_SKIP_REASON).
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { REPO_ROOT } from "../../src/config.js";

export const TLS_FIXTURES = path.join(REPO_ROOT, "tests/fixtures/tls");
export const TLS_SKIP_REASON = "Skipped: the test certificates' private keys are not in tests/fixtures/tls (the repository does not keep keys) and openssl was not found to make new ones.";

let openssl: string | null | undefined;
export function findOpenssl(): string | undefined {
    if (openssl !== undefined) return openssl ?? undefined;
    openssl = null;
    for (const bin of ["openssl", "C:\\Program Files\\Git\\usr\\bin\\openssl.exe", "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe", "/usr/bin/openssl"]) {
        try {
            execFileSync(bin, ["version"], { stdio: "ignore" });
            openssl = bin;
            break;
        } catch {
            /* try the next one */
        }
    }
    return openssl ?? undefined;
}

const minted: string[] = [];
const run = (args: string[], cwd: string) => execFileSync(findOpenssl()!, args, { cwd, stdio: "ignore" });

const SELF_SIGNED = {
    localhost: { cn: "localhost", san: "DNS:localhost,IP:127.0.0.1" },
    "wrong-host": { cn: "shop.example", san: "DNS:shop.example" },
} as const;

/**
 * A self-signed certificate under tests/fixtures/tls, by the name examples/checks-app takes: the published one when its key is there, else one
 * made now as `<name>-minted` (removed by `removeMintedTls`). Undefined when neither is possible.
 */
export function selfSignedTls(name: keyof typeof SELF_SIGNED): { name: string; key: string; cert: string } | undefined {
    const read = (n: string) => ({ name: n, key: fs.readFileSync(path.join(TLS_FIXTURES, `${n}.key`), "utf8"), cert: fs.readFileSync(path.join(TLS_FIXTURES, `${n}.crt`), "utf8") });
    if (fs.existsSync(path.join(TLS_FIXTURES, `${name}.key`))) return read(name);
    if (!findOpenssl()) return undefined;
    const n = `${name}-minted`;
    const { cn, san } = SELF_SIGNED[name];
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${n}.key`, "-out", `${n}.crt`, "-days", "30", "-subj", `/CN=${cn}`, "-addext", "basicConstraints=critical,CA:TRUE", "-addext", `subjectAltName=${san}`], TLS_FIXTURES);
    minted.push(path.join(TLS_FIXTURES, `${n}.key`), path.join(TLS_FIXTURES, `${n}.crt`));
    return read(n);
}

/**
 * The company stand-in (tests/fixtures/tls/company): a root, and a leaf it signed for platform.test, app.test, localhost and 127.0.0.1. The published
 * folder when the leaf's key is there; else a new root and leaf with the same file names in a temporary folder. Undefined when neither is possible.
 */
export function companyTls(): { dir: string; ca: string; cert: string; key: string } | undefined {
    const of = (dir: string) => ({ dir, ca: path.join(dir, "test-company-root.crt"), cert: path.join(dir, "test-company-leaf.crt"), key: path.join(dir, "test-company-leaf.key") });
    const published = of(path.join(TLS_FIXTURES, "company"));
    if (fs.existsSync(published.key)) return published;
    if (!findOpenssl()) return undefined;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aitp-company-tls-"));
    minted.push(dir);
    run(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", "root.key", "-out", "test-company-root.crt", "-days", "30", "-subj", "/CN=TEST ONLY Company Security Root (not a real CA)", "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign"], dir);
    run(["req", "-newkey", "rsa:2048", "-nodes", "-keyout", "test-company-leaf.key", "-out", "leaf.csr", "-subj", "/CN=platform.test"], dir);
    fs.writeFileSync(path.join(dir, "leaf.ext"), "basicConstraints=CA:FALSE\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:platform.test,DNS:app.test,DNS:localhost,IP:127.0.0.1\n");
    run(["x509", "-req", "-in", "leaf.csr", "-CA", "test-company-root.crt", "-CAkey", "root.key", "-CAcreateserial", "-out", "test-company-leaf.crt", "-days", "30", "-extfile", "leaf.ext"], dir);
    return of(dir);
}

/** Removes whatever this file made (call from afterAll). */
export function removeMintedTls(): void {
    for (const p of minted.splice(0)) fs.rmSync(p, { recursive: true, force: true });
}
