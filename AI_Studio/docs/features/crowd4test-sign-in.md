# Signing in with Crowd4Test

AI Studio runs at **aistudio.crowd4test.com** and uses the crowd4test.com sign-in. Nobody signs in to AI Studio separately. Signing out of crowd4test.com also signs the person out of AI Studio, and so does a session an admin ends or an account that gets suspended.

## What people see

- Every portal on crowd4test.com (admin, customer and tester) has an **AI Studio** entry in its sidebar, under *Tools*. It opens AI Studio already signed in.
- Someone who opens aistudio.crowd4test.com while signed out is sent to the crowd4test.com sign-in, then brought back to the AI Studio page they asked for.
- In AI Studio, the account area at the bottom of the sidebar shows the person's side (Admin, Tester or Customer), links to their Profile, and has **Portal** instead of *Sign out*. It goes back to the person's Crowd4Test portal, and signing out there signs out of both.
- AI Studio uses the crowd4test.com look in light mode only: the same colours, type, tints and shadows, and the Crowd4Test mark.

## Who gets in, and what they can do

Access is permission-based (decision D-20). The full model is in [../product-restructure/ACCESS_MODEL.md](../product-restructure/ACCESS_MODEL.md).

- **What a person can do**: a crowd4test.com admin ticks AI Studio features for each tester, manager or customer, in the admin panel (person → **AI Studio access**), or picks a preset. Without **Open AI Studio** (`ai_studio.access`), a person is not let in and the portal hides the sidebar entry. Crowd4Test admins hold every feature.
- **Which projects**: only the projects a person was added to (Project Settings → Members). Crowd4Test admins see every project. Customers can only be added to their own organisation's projects. Linking an AI Studio project to a Crowd4Test project gives nobody access.
- **Project Admin**: a tick on a person's membership. A Project Admin with the approve feature approves tests. The creator of a project is its first Project Admin, and a project always keeps at least one.
- **Never, whatever is ticked**:
  - Testers never see AI cost or usage: the server removes cost and token figures from everything a tester receives.
  - Testers cannot create projects, manage members, manage AI keys or change platform settings.
- A grant or withdrawal in the admin panel applies within 30 seconds. Suspended or deactivated accounts are refused with the reason Crowd4Test gives.
- Schedules and deploy triggers run in their maker's name with nobody signed in. Before each such run AI Studio asks Crowd4Test whether the
  maker's account is still active (the people service, `C4T_SERVICE_TOKEN`); whether they may run tests is what they held when they last
  arrived. An account that is no longer active gets no more runs from its next scheduled or triggered run on, until Crowd4Test lets
  them in again. Someone who keeps an active account but loses AI Studio or "run tests" is stopped only once they next open AI Studio
  (the people service does not say what a person may do), so take them out of the project here too. If Crowd4Test cannot answer, the
  run is not started and the schedule says why.
- People who sign in with Crowd4Test cannot make personal API tokens: a token would keep working after the account was suspended. Scripts and runners use the access key and runner tokens.

## How it works

1. **One cookie for both sites.** crowd4test.com writes `c4t_access` and a small marker, `c4t_shared`, for `.crowd4test.com`, so the browser also sends them to aistudio.crowd4test.com (`AUTH_COOKIE_DOMAIN` in `C4T_Platform/web`). The refresh cookie, `c4t_refresh`, stays on crowd4test.com alone.
2. **AI Studio checks every cookie with the Crowd4Test API.** It calls `GET /v1/auth/me`, the same check every crowd4test.com page makes. It never trusts the cookie by itself. A cookie's answer is reused for 30 seconds, so a page that makes many calls costs one check.
3. **Renewing stays on crowd4test.com.** The access cookie lasts 15 minutes. When it has run out but the `c4t_shared` marker remains, AI Studio answers *renew*.
   - The page then requests `crowd4test.com/app/ai-studio/refresh` in the background, which renews the session, and retries the call. Every call and every download goes through `api()` or `downloadFrom()` in `web/src/api.ts`, so every page renews the same way.
   - AI Studio never spends the refresh token itself. The API treats a refresh token used twice as stolen and ends the session, and crowd4test.com already guards against that for its own renewals.
4. **Changes need AI Studio's own page.** Every crowd4test.com subdomain receives the cookie, so a change (anything other than reading) must also carry the `x-requested-with: ai-studio` header and come from AI Studio's own address. Another site's script cannot add that header without AI Studio agreeing first, and it never agrees.
5. **Old host-only cookies are cleaned up.** Browsers that signed in before the domain was set hold host-only copies of the cookies. On their next visit, crowd4test.com re-scopes those copies to the domain and expires the host-only ones, so a later sign-out removes everything. Nobody has to sign in again (`C4T_Platform/web/src/lib/auth/shared-session.ts`).

The code is in `src/platform/auth/crowd4test.ts` and `src/platform/auth/access.ts` (AI Studio), and in `web/src/lib/auth/shared-session.ts`, `web/src/proxy.ts` and `web/src/app/app/ai-studio/` (C4T_Platform). The tests are `tests/crowd4test-signin.test.ts`.

## Setting it up

**crowd4test.com (C4T_Platform)**

- `web/.env`:
  ```
  AUTH_COOKIE_DOMAIN=.crowd4test.com
  AI_STUDIO_URL=https://aistudio.crowd4test.com
  ```
- `api/.env`: `COOKIE_DOMAIN=.crowd4test.com`, so cookies the API writes itself have the same scope.
- Rebuild and restart the web app. The **AI Studio** sidebar entry appears only once `AI_STUDIO_URL` is set.

**aistudio.crowd4test.com (AI_Studio)**

- `.env`:
  ```
  C4T_API_ORIGIN=http://127.0.0.1:4000
  C4T_SITE_URL=https://crowd4test.com
  PUBLIC_URL=https://aistudio.crowd4test.com
  PORT=4100
  ```
- `C4T_API_ORIGIN` is how this server reaches the Crowd4Test API, which is the loopback address when both run on one machine. The Crowd4Test API already uses port 4000 there, so give AI Studio another port.
- `C4T_SERVICE_TOKEN`, the same value as `AI_STUDIO_SERVICE_TOKEN` in the Crowd4Test API's `.env` (at least 32 characters). Without it, schedules and deploy triggers made by Crowd4Test accounts do not run (AI Studio cannot confirm their account is still active). With it, AI Studio asks Crowd4Test's service endpoints (`/v1/ai-studio/*`, `src/platform/c4t-service.ts`) for:
  - organisation names and statuses (Projects, and `GET /api/organizations`), and whether an organisation staff create a project in exists and is active;
  - the Crowd4Test projects of an organisation, for linking one to an AI Studio project (a reference only: it grants nobody access);
  - the people search on a project's Members page, so people who never opened AI Studio can be added.

  Without it these fall back to what AI Studio already knows: organisations by id only, no linking, and only people who have signed in. Each question waits at most 5 seconds; organisations are cached for 5 minutes, people searches for 30 seconds. When Crowd4Test cannot be reached, the page says so.
- Keep `API_KEY` set for scripts, the `ai-test` command and runners.
- Set `SECRET_KEY` (at least 16 characters, kept in a secret store) and `SECRET_KEY_REQUIRED=true`, so AI Studio refuses to start without the key instead of making a key file on disk.
- Point DNS for `aistudio.crowd4test.com` at the server.
- Add an nginx site that serves it over HTTPS and passes everything to `127.0.0.1:4100`, with `X-Forwarded-For` set so the Crowd4Test API sees each visitor's address.

**In development**, leave `AUTH_COOKIE_DOMAIN` unset. Cookies on `localhost` are shared across ports anyway, so the C4T website on `localhost:3000` and AI Studio on `localhost:4100` already see the same session.
