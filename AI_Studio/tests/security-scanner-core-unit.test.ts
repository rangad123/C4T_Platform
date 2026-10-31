/**
 * The scanner layer's own rules: which tools may run at all, at what profile, what they promise, and how a tool process is started.
 *
 * These are unit tests with no tool installed. Nothing here runs a scanner: the point is that the gates hold before any tool is asked
 * to do anything, and that the gates are the same ones a test with a real tool relies on.
 */
import { describe, expect, it } from "vitest";
import { SCANNER_IDS } from "../src/security/scanners/contract.js";
import { atMost, profileRefusal, profileStatement, requiredApproval, SCAN_PROFILES } from "../src/security/scanners/profiles.js";
import { enabledScanners, notEnabledReason, scannerSettings, scannerSettingsPublic, zapBaseUrl } from "../src/security/scanners/settings.js";
import { planSpawn, quoteForCmd } from "../src/security/scanners/cmd-shim.js";
import { scrubbedEnv } from "../src/security/scanners/process.js";

describe("which scanners may run at all", () => {
    it("runs none until an administrator names them", () => {
        expect(enabledScanners(undefined)).toEqual([]);
        expect(enabledScanners("")).toEqual([]);
        expect(scannerSettings({}).enabled).toEqual([]);
    });

    it("names only the scanners it knows, in a fixed order, whatever order or spelling it is given", () => {
        expect(enabledScanners("nuclei, zap")).toEqual(["zap", "nuclei"]);
        expect(enabledScanners("  ZAP ; nuclei  ")).toEqual(["zap", "nuclei"]);
        expect(enabledScanners("zap,burp,sqlmap")).toEqual(["zap"]);
        expect(enabledScanners("every tool")).toEqual([]);
    });

    it("keeps a known scanner out of the list until it is named, and says what to do", () => {
        const settings = scannerSettings({ SECURITY_SCANNERS: "zap" });
        expect(settings.enabled).toEqual(["zap"]);
        expect(notEnabledReason("nuclei").reason).toContain("not switched on");
        expect(notEnabledReason("nuclei").remedy).toContain("SECURITY_SCANNERS");
    });
});

describe("a scanner credential never reaches the browser", () => {
    const secret = "super-secret-zap-key";
    const view = scannerSettingsPublic(scannerSettings({ SECURITY_ZAP_API_KEY: secret, SECURITY_ZAP_URL: "http://127.0.0.1:8090" }));

    it("reports the key as present, and never as a value", () => {
        expect(JSON.stringify(view)).toContain("apiKeySet");
        expect(JSON.stringify(view)).not.toContain(secret);
        expect((view.zap as { apiKeySet: boolean }).apiKeySet).toBe(true);
    });

    it("reports no other configured path either, because a path names a machine", () => {
        const withPaths = JSON.stringify(scannerSettingsPublic(scannerSettings({ SECURITY_NUCLEI_PATH: "C:/tools/nuclei.exe", SECURITY_NUCLEI_TEMPLATES: "C:/tools/templates" })));
        expect(withPaths).not.toContain("C:/tools");
        expect(withPaths).toContain("pathSet");
    });

    it("accepts only an http(s) ZAP base address", () => {
        expect(zapBaseUrl("http://127.0.0.1:8090/")).toBe("http://127.0.0.1:8090");
        expect(zapBaseUrl("https://zap.internal/api/")).toBe("https://zap.internal/api");
        expect(zapBaseUrl("file:///etc/passwd")).toBe("");
        expect(zapBaseUrl("not a url")).toBe("");
        expect(zapBaseUrl("")).toBe("");
    });
});

describe("scan profiles", () => {
    it("orders the levels, so 'at most this' is a comparison", () => {
        // atMost(allowed, p) answers "may p run when the profile allows at most `allowed`?"
        expect(atMost("passive", "passive")).toBe(true);
        expect(atMost("passive", "conservative-active")).toBe(false);
        expect(atMost("passive", "advanced")).toBe(false);
        expect(atMost("conservative-active", "passive")).toBe(true);
        expect(atMost("conservative-active", "conservative-active")).toBe(true);
        expect(atMost("advanced", "conservative-active")).toBe(true);
        expect(atMost("advanced", "advanced")).toBe(true);
    });

    it("needs no approval for the passive and conservative levels", () => {
        expect(SCAN_PROFILES.passive.requiresApproval).toBe(false);
        expect(SCAN_PROFILES["conservative-active"].requiresApproval).toBe(false);
        expect(SCAN_PROFILES.advanced.requiresApproval).toBe(true);
    });

    it("refuses an advanced run for production even when an approval exists", () => {
        expect(profileRefusal("advanced", "production", true)).toMatch(/production/i);
        expect(profileRefusal("advanced", "staging", false)).toMatch(/approval/i);
        expect(profileRefusal("advanced", "staging", true)).toBeUndefined();
        expect(profileRefusal("conservative-active", "production", false)).toBeUndefined();
    });

    it("never promises anything it does not do, at any level", () => {
        for (const profile of Object.values(SCAN_PROFILES)) {
            const text = profile.never.join(" ").toLowerCase();
            expect(text).toContain("never deletes");
            expect(text).toContain("persistence");
            expect(text).toContain("steals a credential");
            expect(text).toContain("bypass");
        }
    });

    it("records an approval as the exact sentence a person confirmed, for a named environment", () => {
        const approval = requiredApproval("advanced", "staging", { id: "u1", name: "Ana" }, new Date("2026-01-02T03:04:05Z"));
        expect(approval).toBeDefined();
        expect(approval?.approvedByUserId).toBe("u1");
        expect(approval?.approvedByName).toBe("Ana");
        expect(approval?.environment).toBe("staging");
        // The stored statement is the sentence that goes into the audit trail: it names the profile AND the environment it covers, so an
        // approval for staging can never be read later as an approval for production.
        expect(approval?.statement).toContain("staging");
        expect(approval?.statement).toContain(SCAN_PROFILES.advanced.title);
        expect(profileStatement("advanced")).toContain("never for production");
        expect(requiredApproval("passive", "production", { id: "u1", name: "Ana" })).toBeUndefined();
    });
});

describe("a scanner process is started without a shell and without the platform's secrets", () => {
    it("withholds everything except the operating-system variables and what the adapter passes", () => {
        process.env.LLM_API_KEY = "platform-secret";
        process.env.SECRET_KEY = "platform-secret";
        try {
            const env = scrubbedEnv({ SECURITY_ZAP_API_KEY: "zap-key" });
            expect(env.LLM_API_KEY).toBeUndefined();
            expect(env.SECRET_KEY).toBeUndefined();
            expect(env.SECURITY_ZAP_API_KEY).toBe("zap-key");
            expect(env.PATH ?? env.Path).toBe(process.env.PATH ?? process.env.Path);
        } finally {
            delete process.env.LLM_API_KEY;
            delete process.env.SECRET_KEY;
        }
    });

    it("spawns a real executable directly, with no interpreter at all", () => {
        const plan = planSpawn(process.execPath, ["--version"]);
        expect(plan.file).toBe(process.execPath);
        expect(plan.viaCommandInterpreter).toBe(false);
        expect(plan.verbatimArguments).toBe(false);
    });

    it("quotes each element for the Windows command interpreter, which is only used for a batch shim", () => {
        expect(quoteForCmd("a b")).toBe('"a b"');
        expect(quoteForCmd('say "hi"')).toBe('"say \\"hi\\""');
        const plan = planSpawn("C:/tools/tool.cmd", ["--flag", "C:/a b/c.json"]);
        expect(plan.viaCommandInterpreter).toBe(process.platform === "win32");
        if (plan.viaCommandInterpreter) {
            expect(plan.file.toLowerCase()).toContain("cmd");
            expect(plan.verbatimArguments).toBe(true);
            // One argument after /c, holding the whole quoted command line: that is the form cmd.exe actually accepts.
            expect(plan.args.slice(0, 3)).toEqual(["/d", "/s", "/c"]);
            expect(plan.args).toHaveLength(4);
            expect(plan.args[3]).toContain('"C:/tools/tool.cmd" "--flag" "C:/a b/c.json"');
        }
    });

    it("refuses an argument the command interpreter would reinterpret, instead of quoting it hopefully", () => {
        for (const bad of ["a & calc", "a | more", "%PATH%", "!DELAYED!", "a > out", "a^b", "a\nb"]) {
            if (process.platform !== "win32") break;
            expect(() => planSpawn("C:/tools/tool.cmd", [bad])).toThrow(/Windows would reinterpret/);
        }
        if (process.platform === "win32") expect(() => planSpawn("C:/tools/a&b.cmd", [])).toThrow(/Windows would reinterpret/);
    });
});

describe("the module only knows four scanners, and says so rather than pretending to know more", () => {
    it("lists exactly the four reviewed integrations", () => {
        expect([...SCANNER_IDS]).toEqual(["zap", "nuclei", "schemathesis", "promptfoo"]);
    });
});
