import { useState } from "react";
import { RotateCcw, Trash2 } from "lucide-react";
import { Button, Disclosure } from "../../components/ui";
import { FRESH, SecretField, type AgentInputs, type SecretState } from "../requirements/AgentInputs";

type ApiAccess = AgentInputs["apiAccess"];

/**
 * The main account's API access (a bearer token, or OAuth2 client credentials) on Settings → Sign-in, for a project tested by the AI
 * agent: what its API explorations and API tests send. Saved with PUT /agent-inputs (only the API part: everything else there stays).
 * Secrets are write-only, as everywhere: a saved one says "Saved", with Replace and Remove.
 */
export function useApiAccessForm(a: ApiAccess) {
    const o = a.oauth2;
    const [token, setToken] = useState<SecretState>(FRESH);
    const [clientSecret, setClientSecret] = useState<SecretState>(FRESH);
    const [oauth, setOauth] = useState({ tokenUrl: o?.tokenUrl ?? "", clientId: o?.clientId ?? "", scope: o?.scope ?? "" });
    const [removeOauth, setRemoveOauth] = useState(false);
    const oauthEdited = oauth.tokenUrl !== (o?.tokenUrl ?? "") || oauth.clientId !== (o?.clientId ?? "") || oauth.scope !== (o?.scope ?? "") || Boolean(clientSecret.value);
    /** Something to save: otherwise saving the sign-in leaves the API access alone. */
    const changed = Boolean(token.value || token.remove || removeOauth || oauthEdited);

    function body() {
        const clear = [token.remove && "apiToken", removeOauth && "oauth2"].filter(Boolean) as string[];
        return {
            apiToken: token.value.trim() || undefined,
            oauth2: !removeOauth && oauthEdited ? { tokenUrl: oauth.tokenUrl, clientId: oauth.clientId, scope: oauth.scope || undefined, clientSecret: clientSecret.value || undefined } : undefined,
            clear: clear.length ? clear : undefined,
        };
    }

    const fields = (canEdit: boolean) => (
        <div className="stack-sm" data-testid="sign-in-api-access">
            <div>
                <div className="t-card">API access (optional)</div>
                <p className="hint">For testing endpoints that need authorization: a bearer token, or OAuth2 client credentials. The agents’ API explorations and API tests send it.</p>
            </div>
            <SecretField id="si-token" label="Bearer token" saved={a.hasToken} state={token} onChange={(s) => setToken((t) => ({ ...t, ...s }))} canEdit={canEdit} />
            <Disclosure label="Use OAuth2 client credentials instead" defaultOpen={Boolean(o)}>
                {removeOauth ? (
                    <div className="row">
                        <span className="t-secondary">The OAuth2 client credentials are removed when you save.</span>
                        <Button size="sm" variant="ghost" icon={RotateCcw} onClick={() => setRemoveOauth(false)}>
                            Undo
                        </Button>
                    </div>
                ) : (
                    <div className="stack-sm">
                        <div className="grid-2">
                            <div className="field">
                                <label htmlFor="si-o-url">OAuth2 token URL</label>
                                <input id="si-o-url" className="input" type="url" value={oauth.tokenUrl} disabled={!canEdit} onChange={(e) => setOauth({ ...oauth, tokenUrl: e.target.value })} />
                            </div>
                            <div className="field">
                                <label htmlFor="si-o-scope">OAuth2 scope</label>
                                <input id="si-o-scope" className="input" value={oauth.scope} disabled={!canEdit} onChange={(e) => setOauth({ ...oauth, scope: e.target.value })} />
                            </div>
                            <div className="field">
                                <label htmlFor="si-o-id">OAuth2 client ID</label>
                                <input id="si-o-id" className="input" autoComplete="off" value={oauth.clientId} disabled={!canEdit} onChange={(e) => setOauth({ ...oauth, clientId: e.target.value })} />
                            </div>
                            <SecretField id="si-o-secret" label="OAuth2 client secret" saved={Boolean(o?.hasClientSecret)} state={clientSecret} onChange={(s) => setClientSecret((c) => ({ ...c, ...s }))} canEdit={canEdit} removable={false} />
                        </div>
                        {o && canEdit && (
                            <div>
                                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => setRemoveOauth(true)}>
                                    Remove the OAuth2 client credentials
                                </Button>
                            </div>
                        )}
                    </div>
                )}
            </Disclosure>
        </div>
    );

    return { changed, body, fields };
}
