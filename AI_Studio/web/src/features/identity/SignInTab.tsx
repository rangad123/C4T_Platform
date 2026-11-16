import { ProjectSignInPanel } from "./ProjectSignIn";
import { SavedSignInControls, TestMailboxPanel, useSavedSignIns } from "./HardSignInPanel";
import { RESERVED_ACCOUNT, TestAccountsPanel } from "./TestAccountsPanel";

/**
 * Settings → Sign-in: who tests sign in as. Each account appears once, with everything about it: the main account (user name,
 * password, authenticator secret, API access, and "Signed in by hand"), then the other test accounts the same way, then the test
 * mailbox for emailed codes and links. The saved sign-ins are read once for the whole tab.
 */
export function SignInTab({ projectId }: { projectId: string }) {
    const hs = useSavedSignIns(projectId);
    return (
        <div className="stack">
            <ProjectSignInPanel projectId={projectId} byHand={<SavedSignInControls hs={hs} account={RESERVED_ACCOUNT} />} />
            {/* A link can open this part: routes.projectSettings(id, "signin") with #accounts, and the older Test accounts links. */}
            <div id="accounts" tabIndex={-1} className="stack">
                <TestAccountsPanel projectId={projectId} byHand={(name) => <SavedSignInControls hs={hs} account={name} />} />
            </div>
            <TestMailboxPanel hs={hs} />
        </div>
    );
}
