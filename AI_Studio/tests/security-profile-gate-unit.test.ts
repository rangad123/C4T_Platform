/**
 * The profile gate (src/security/profile-gate.ts) as pure rules: which start is refused and with which sentence, in which order; the
 * authorization sentence for passive is exactly the one it always was, and a higher profile and cross-account accounts are named in it;
 * the cross-account step's consent rule; stored values read back safely.
 */
import { describe, expect, it } from "vitest";
import { authorizationStatement } from "../src/security/authorization.js";
import { approvalStatement, crossAccountConsentProblem, crossAccountsOf, GATE_WORDS, maxProfileOf, startRefusal, type ProfileApproval } from "../src/security/profile-gate.js";
import { signInLabel } from "../src/security/authorization.js";

const approval = (profile: ProfileApproval["profile"], environment = "staging"): ProfileApproval => ({
    id: "ap1",
    applicationId: "a1",
    profile,
    environment,
    approvedByUserId: "u1",
    approvedByName: "Olga",
    approvedAt: "2026-11-14T00:00:00.000Z",
    statement: "x",
    withdrawnAt: null,
    withdrawnBy: null,
    detailsFingerprint: "fp",
    expiresAt: "2026-12-14T00:00:00.000Z",
});
const app = { targetUrl: "https://shop.example.com/", scope: [], excludedPaths: [], signInAccount: null, sensitiveWorkflows: [] };

describe("startRefusal", () => {
    it("never refuses passive, whatever else is true", () => {
        for (const on of [true, false]) expect(startRefusal({ kind: "passive", environment: "production", authorizationMaxProfile: "passive", approval: undefined, activeProfilesOn: on, crowd4testOn: on })).toBeUndefined();
    });

    it("refuses above passive outside development and staging, whatever else is true", () => {
        for (const environment of ["production", "other"])
            for (const kind of ["conservative-active", "advanced"] as const)
                expect(startRefusal({ kind, environment, authorizationMaxProfile: "advanced", approval: approval(kind, environment), activeProfilesOn: true, crowd4testOn: true })).toBe(GATE_WORDS.wrongEnvironment(environment));
        expect(startRefusal({ kind: "conservative-active", environment: "development", authorizationMaxProfile: "conservative-active", approval: approval("conservative-active", "development"), activeProfilesOn: true, crowd4testOn: true })).toBeUndefined();
    });

    it("refuses above passive in order: environment, authorization, Crowd4Test sign-in, approval, the server switch", () => {
        const base = { environment: "staging", activeProfilesOn: true, crowd4testOn: true } as const;
        expect(startRefusal({ ...base, kind: "conservative-active", authorizationMaxProfile: "passive", approval: approval("conservative-active") })).toBe(GATE_WORDS.notAuthorized("Conservative active checks"));
        expect(startRefusal({ ...base, kind: "advanced", authorizationMaxProfile: "conservative-active", approval: approval("advanced") })).toMatch(/client's current authorization does not allow the Advanced assessment/);
        expect(startRefusal({ ...base, kind: "conservative-active", authorizationMaxProfile: "advanced", approval: undefined })).toBe(GATE_WORDS.notApproved("Conservative active checks", "staging"));
        // Without Crowd4Test sign-in nobody can approve, so even a stored approval does not let it start, and the refusal says why.
        expect(startRefusal({ ...base, crowd4testOn: false, kind: "conservative-active", authorizationMaxProfile: "advanced", approval: approval("conservative-active") })).toBe(GATE_WORDS.noCrowd4Test);
        expect(startRefusal({ ...base, activeProfilesOn: false, kind: "conservative-active", authorizationMaxProfile: "conservative-active", approval: approval("conservative-active") })).toBe(GATE_WORDS.switchedOff);
        expect(startRefusal({ ...base, kind: "conservative-active", authorizationMaxProfile: "conservative-active", approval: approval("conservative-active") })).toBeUndefined();
        expect(startRefusal({ ...base, kind: "conservative-active", authorizationMaxProfile: "advanced", approval: approval("conservative-active") })).toBeUndefined();
    });
});

describe("the authorization sentence", () => {
    const PASSIVE = "I confirm that Client owns https://shop.example.com/ or that its owner has given documented permission to assess it, within the scope listed. The assessment is passive: it only sends the ordinary requests a visitor's browser makes.";

    it("is exactly the passive sentence it always was, without a choice or with passive and no accounts", () => {
        expect(authorizationStatement("Client", app)).toBe(PASSIVE);
        expect(authorizationStatement("Client", app, { maxProfile: "passive", crossAccounts: [] })).toBe(PASSIVE);
    });

    it("names the highest allowed profile and the approval it needs, and no longer says passive", () => {
        const s = authorizationStatement("Client", app, { maxProfile: "advanced" });
        expect(s).toMatch(/may run at most the Advanced assessment \(controlled environment only\) profile/);
        // The client's authorization and the Crowd4Test admin's approval are two different things, and the sentence says so.
        expect(s).toMatch(/This authorization does not approve the profile by itself: each run above passive also needs a Crowd4Test admin's approval for this application's environment\./);
        expect(s).toMatch(/runs only while the application is marked as development or staging/);
        // The current wording: no promise that read requests have no side effect; detection is said to be manual; no undo requests.
        expect(s).toMatch(/The platform prohibits intentional operations that change data: no request is meant to create, update, delete or overwrite anything, and a check that would need one is skipped and listed as skipped in the report\./);
        expect(s).toMatch(/A target application may still have unintended side effects even from read requests\./);
        expect(s).toMatch(/The platform does not detect such a change automatically/);
        expect(s).toMatch(/the tester records what was observed in the report and the client is told, and no further request is made to undo it\./);
        expect(s).not.toMatch(/Nothing in the application is created/);
        expect(s).not.toMatch(/The assessment is passive/);
    });

    it("names the two cross-account test accounts", () => {
        expect(authorizationStatement("Client", app, { crossAccounts: ["alice", "bob"] })).toMatch(/signs in, read-only, as the test account “alice” and the test account “bob”/);
    });

    it("an approval sentence names the profile, the application and its environment", () => {
        expect(approvalStatement("advanced", { name: "Shop", targetUrl: "https://shop.example.com/", environment: "staging" })).toMatch(/^As a Crowd4Test admin, I approve the Advanced assessment .* for “Shop” \(https:\/\/shop.example.com\/\), marked as a staging environment\. This approval is separate from the client's authorization/);
    });
});

describe("the cross-account step's consent", () => {
    it("runs only when both accounts are named", () => {
        expect(crossAccountConsentProblem(["alice", "bob"], "alice", "bob", signInLabel)).toBeUndefined();
        expect(crossAccountConsentProblem([], "alice", "bob", signInLabel)).toMatch(/does not name the test account “alice” and the test account “bob”/);
        expect(crossAccountConsentProblem(["alice"], "alice", "bob", signInLabel)).toMatch(/does not name the test account “bob”\./);
    });
});

describe("stored values", () => {
    it("an authorization recorded before the gate allows passive only and names no account", () => {
        for (const raw of [null, undefined, "", "bogus", 3]) expect(maxProfileOf(raw)).toBe("passive");
        expect(maxProfileOf("advanced")).toBe("advanced");
        for (const raw of [null, "", "{", "\"x\"", "[1,2]"]) expect(crossAccountsOf(raw)).toEqual([]);
        expect(crossAccountsOf('["a","b","c"]')).toEqual(["a", "b"]);
    });
});
