import { ArrowLeft, LogOut } from "lucide-react";
import { useState } from "react";
import { setKey } from "../../api";
import { Tooltip } from "../../components/Tooltip";
import { Button, LinkButton } from "../../components/ui";
import { ROLE_HELP, ROLE_WORDS, signOut, useAuth } from "./auth";
import { SIDE_WORDS, sideOf } from "./permissions";
import { routes } from "../../lib/router";

/** In the sidebar: who is using the platform, their role, and Sign out (for a person; the access key is forgotten instead). */
export function AccountChip() {
    const { state, refresh } = useAuth();
    const [busy, setBusy] = useState(false);
    const me = state?.me;
    const side = sideOf(me);
    if (!me || me.kind === "open") return null;
    const leave = async () => {
        setBusy(true);
        try {
            if (me.kind === "user") await signOut();
            else setKey("");
        } catch {
            /* the cookies are cleared by the server; a failed call still forgets the page state below */
        } finally {
            setBusy(false);
            refresh();
        }
    };
    return (
        <div className="row" style={{ gap: 8, alignItems: "center", padding: "6px 0" }} data-tour="nav-account">
            <div style={{ minWidth: 0, flex: 1 }}>
                {/* The name opens Profile: the account, and the features this person may use. */}
                <Tooltip content={me.kind === "user" && me.name.length > 20 ? me.name : "Your profile"}>
                    <a className="truncate" href={routes.profile} style={{ fontWeight: 600, display: "block", color: "inherit" }}>
                        {me.kind === "user" ? me.name : "Access key"}
                    </a>
                </Tooltip>
                {/* A Crowd4Test account shows its side: its features, not a role, decide what it can do (decision D-20). */}
                {side !== "local" ? (
                    <Tooltip content="What you can do is chosen by a Crowd4Test administrator. Your profile lists it.">
                        <div className="t-meta" tabIndex={0} style={{ width: "fit-content" }}>{SIDE_WORDS[side]}</div>
                    </Tooltip>
                ) : (
                    /* A person limited to some projects (per-project access): the role's sentence would promise pages they cannot open. */
                    <Tooltip content={state?.projectAccess === "only" ? `Limited to the projects an owner chose for you, with the role chosen in each (never above ${ROLE_WORDS[me.role]}). Platform-wide pages stay closed to you.` : ROLE_HELP[me.role]}>
                        <div className="t-meta" tabIndex={0} style={{ width: "fit-content" }}>{ROLE_WORDS[me.role]}</div>
                    </Tooltip>
                )}
            </div>
            {/* Signed in with Crowd4Test: signing out happens in the portal, and signs out of both. */}
            {me.kind === "user" && me.via === "crowd4test" && state?.crowd4test ? (
                <LinkButton variant="ghost" size="sm" icon={ArrowLeft} href={state.crowd4test.portalUrl} tip="Back to your Crowd4Test portal. Signing out there signs you out of AI Studio too.">
                    Portal
                </LinkButton>
            ) : (
            <Button variant="ghost" size="sm" icon={LogOut} loading={busy} onClick={() => void leave()} tip={me.kind === "user" ? undefined : "Removes the access key from this browser. You need the key again to come back in."}>
                {me.kind === "user" ? "Sign out" : "Forget key"}
            </Button>
            )}
        </div>
    );
}
