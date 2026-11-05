/**
 * The route-to-permission table: the `ai_studio.*` code each API route needs (auth/permissions.ts). One table for the whole platform,
 * checked by the access hook (auth/access.ts) and tested exhaustively (tests/users-unit.test.ts fails when a registered route is
 * missing here, tests/permissions-unit.test.ts when a rule is not a known code).
 *
 *   read                         only ai_studio.access (and the project in reach): viewing projects, tests, runs, reports, and the
 *                                POSTs that store nothing (step-text conversions, script checks, previews, live-update tickets)
 *   ai_studio.project.create     a new project
 *   ai_studio.project.settings   project settings: framework, environments and their credentials, test accounts and saved sign-ins,
 *                                the phone, the app, cleanup, which runner or device farm runs the tests, retention previews
 *   ai_studio.tests.write        tests, specs, scripts, steps, shared elements, blocks, helpers, imports, recordings, test data and
 *                                files, quarantine, healing, baselines, runbooks, issues filed from a test
 *   ai_studio.tests.generate     the AI writes or rewrites tests: generation jobs, plans made into tests, plain-language tests, the
 *                                connection check of the AI model, the one-time code an exploration waits for
 *   ai_studio.tests.run          runs, validation, browser variants, schedules, run sequences, manual results and release sign-off,
 *                                cancelling a job, trying the test-data reset
 *   ai_studio.agent.run          an AI agent driving a live session step by step (POST /api/recordings/:rid/act)
 *   ai_studio.reports.export     downloads: reports, JUnit, test code, exports of cases and elements, security reports
 *   ai_studio.tests.delete       deleting tests and what they are made of: cases, elements, blocks, helpers, data, files, imports,
 *                                plans, recordings, run sequences, site memory
 *   ai_studio.tests.approve      sign-offs: the client's permission to assess (security), accepting a risk (checked in the route).
 *                                Approving a test also needs Project Admin on the project (canApprove in auth/project-scope.ts)
 *   ai_studio.runners.manage     runner tokens, runner kits, runner updates, registering, renaming and retiring a runner, giving projects access to it
 *   ai_studio.ai_keys.manage     keys and connections to other systems: issue trackers, Sentry, alert channels, the test mailbox,
 *                                deploy-trigger tokens, device-farm credentials
 *   ai_studio.usage.view         reading AI usage, prices and budgets
 *   ai_studio.security.use       the Security Assessment module: applications, assessments, findings, scanners, sign-ins
 *   ai_studio.project.members    a project's people and its Project Admins (routes/members.ts)
 *   ai_studio.platform.settings  people, activity and single sign-on of the whole platform, AI settings, prices and budgets,
 *                                retention, evaluation runs, whole-project backups and restores, removing a security application
 *   public                       no sign-in needed (signing in itself, the auth state)
 *   own                          the route checks its own credential (runner token, deploy-trigger token, stream ticket, health)
 *
 * A local account (owner, editor, viewer, the access key) holds its role's codes (ROLE_PERMISSIONS), so every route allows and refuses
 * exactly what it did when this table named roles; ROUTE_ROLES below is that view, derived from this table. A route that is not in
 * the table needs ai_studio.platform.settings (fail closed: owners only, as before). HEAD follows GET.
 */
import type { Role } from "./actor.js";
import { leastRoleFor, type Permission } from "./permissions.js";

export type PermissionRule = Permission | "read" | "public" | "own";
/** The rule in local-role words: the least role that passes (what the route table said before permissions). */
export type Rule = Role | "public" | "own";

/** What a route not in the table needs. */
export const UNLISTED_NEEDS: Permission = "ai_studio.platform.settings";

export const ROUTE_PERMISSIONS: Record<string, PermissionRule> = {
    // ── not the API: the web page's files and CORS preflights ──
    "GET /*": "public",
    "OPTIONS *": "public",

    // ── own credential (checked before permissions, exactly as before accounts existed) ──
    "GET /api/health": "own",
    "POST /api/triggers/:token/run": "own",
    "GET /api/triggers/:token/status/:jobId": "own",
    "POST /api/agent/hello": "own",
    "POST /api/agent/poll": "own",
    "POST /api/agent/tasks/:id/heartbeat": "own",
    "GET /api/agent/tasks/:id/files/:ref": "own",
    "PUT /api/agent/tasks/:id/files/:name": "own",
    "POST /api/agent/tasks/:id/recording": "own",
    "POST /api/agent/tasks/:id/result": "own",
    "POST /api/agent/tasks/:id/device": "own",
    "POST /api/agent/update": "own",
    "GET /api/agent/update/files/:name": "own",
    "POST /api/agent/check": "own",

    // ── signing in, and a person's own account (routes/auth.ts) ──
    "GET /api/auth/state": "public",
    "POST /api/auth/sign-in": "public",
    "POST /api/auth/sign-out": "public",
    "POST /api/auth/setup": "public", // the route itself requires the access key (or open access) and no people yet
    "POST /api/auth/invite/check": "public",
    "POST /api/auth/invite/accept": "public",
    "GET /api/auth/sso/start": "public",
    "GET /api/auth/sso/callback": "public",
    "PUT /api/me/password": "read",
    "POST /api/me/sign-out-everywhere": "read",
    "GET /api/me/tokens": "read",
    "POST /api/me/tokens": "read",
    "DELETE /api/me/tokens/:tokenId": "read",

    // ── people, activity, single sign-on (routes/users.ts) ──
    "GET /api/users": "ai_studio.platform.settings",
    "POST /api/users": "ai_studio.platform.settings",
    "PATCH /api/users/:userId": "ai_studio.platform.settings",
    "DELETE /api/users/:userId": "ai_studio.platform.settings",
    "POST /api/users/:userId/reset-link": "ai_studio.platform.settings",
    "POST /api/users/:userId/sign-out": "ai_studio.platform.settings",
    // Per-project access (routes/project-access.ts): all projects, or only some with a role in each.
    "PUT /api/users/:userId/projects": "ai_studio.platform.settings",
    "GET /api/activity": "ai_studio.platform.settings",
    "GET /api/sso-settings": "ai_studio.platform.settings",
    "PUT /api/sso-settings": "ai_studio.platform.settings",
    "DELETE /api/sso-settings": "ai_studio.platform.settings",

    // ── platform-wide ──
    "GET /api/config": "read",
    "GET /api/mobile/emulator-setup": "read",
    "GET /api/dashboard": "read",
    "GET /api/storage": "read",
    "GET /api/usage": "ai_studio.usage.view",
    "GET /api/usage/prices": "ai_studio.usage.view",
    "PUT /api/usage/prices": "ai_studio.platform.settings",
    "DELETE /api/usage/prices": "ai_studio.platform.settings",
    "GET /api/usage/budgets": "ai_studio.usage.view",
    "PUT /api/usage/budgets": "ai_studio.platform.settings",
    "GET /api/jobs/:id/usage": "ai_studio.usage.view",
    "GET /api/dsl/phrases": "read",
    // Pure conversions between steps and text: nothing is stored.
    "POST /api/dsl/parse": "read",
    "POST /api/dsl/print": "read",
    // A single-use ticket to open a live-update stream: watching is reading.
    "POST /api/stream-tickets": "read",
    "GET /api/artifacts/:id": "read",

    // ── projects ──
    "GET /api/projects": "read",
    "POST /api/projects": "ai_studio.project.create",
    // A backup file brings a whole project with its stored secrets.
    "POST /api/projects/restore": "ai_studio.platform.settings",
    "GET /api/projects/:id": "read",
    "POST /api/projects/:id/test-generation": "ai_studio.tests.generate",
    "GET /api/projects/:id/tests": "read",
    "GET /api/projects/:id/suites": "read",
    // Test suites a person builds (routes/suites.ts): reading is access, changing is tests.write, running is tests.run.
    "GET /api/projects/:id/agent-runs": "read",
    "POST /api/projects/:id/agent-runs": "ai_studio.agent.run",
    "GET /api/projects/:id/agent-runs/:rid": "read",
    "POST /api/projects/:id/agent-runs/:rid/stop": "ai_studio.agent.run",
    "POST /api/projects/:id/agent-runs/:rid/approvals/:aid": "ai_studio.agent.run",
    "POST /api/projects/:id/agent-runs/:rid/draft": "ai_studio.tests.write",
    "GET /api/projects/:id/test-suites": "read",
    "POST /api/projects/:id/test-suites": "ai_studio.tests.write",
    "GET /api/projects/:id/test-suites/:sid": "read",
    "PATCH /api/projects/:id/test-suites/:sid": "ai_studio.tests.write",
    "DELETE /api/projects/:id/test-suites/:sid": "ai_studio.tests.write",
    "POST /api/projects/:id/test-suites/:sid/tests": "ai_studio.tests.write",
    "DELETE /api/projects/:id/test-suites/:sid/tests/:testId": "ai_studio.tests.write",
    "PUT /api/projects/:id/test-suites/:sid/order": "ai_studio.tests.write",
    "POST /api/projects/:id/test-suites/:sid/duplicate": "ai_studio.tests.write",
    "POST /api/projects/:id/test-suites/:sid/run": "ai_studio.tests.run",
    "GET /api/projects/:id/specs": "read",
    "POST /api/projects/:id/specs": "ai_studio.tests.write",
    "GET /api/projects/:id/compliance": "read",
    "GET /api/projects/:id/application-model": "read",
    "GET /api/projects/:id/junit": "ai_studio.reports.export",
    "GET /api/projects/:id/download": "ai_studio.reports.export",
    "GET /api/projects/:id/report": "ai_studio.reports.export",
    "GET /api/projects/:id/trends": "read",
    "GET /api/projects/:id/flaky": "read",
    "GET /api/projects/:id/jobs": "read",
    "GET /api/projects/:id/jobs/:jobId/frame": "read",
    "GET /api/projects/:id/stream": "read",
    "GET /api/projects/:id/storage": "read",
    "GET /api/projects/:id/performance": "read",
    "GET /api/projects/:id/api-changes": "read",
    "POST /api/projects/:id/api-diff": "ai_studio.tests.write",
    "PUT /api/projects/:id/mobile-app": "ai_studio.project.settings",
    "POST /api/projects/:id/mobile-app/apk": "ai_studio.project.settings",
    // The app by platform (round 37, routes/project-app.ts): store links and an uploaded iPhone app.
    "GET /api/projects/:id/app-details": "read",
    "PUT /api/projects/:id/app-details": "ai_studio.project.settings",
    "POST /api/projects/:id/app-details/ipa": "ai_studio.project.settings",
    "GET /api/projects/:id/memory": "read",
    "DELETE /api/projects/:id/memory": "ai_studio.tests.delete",
    "GET /api/projects/:id/cleanup": "read",
    "PUT /api/projects/:id/cleanup/settings": "ai_studio.project.settings",
    "POST /api/projects/:id/cleanup/retry": "ai_studio.tests.run",
    "POST /api/projects/:id/variants": "ai_studio.tests.run",
    "POST /api/projects/:id/validation": "ai_studio.tests.run",
    "POST /api/projects/:id/runs": "ai_studio.tests.run",
    "GET /api/projects/:id/runs/:jobId": "read",
    "GET /api/projects/:id/runs/:jobId/summary": "read",
    "GET /api/projects/:id/plans/:jobId": "read",
    "DELETE /api/projects/:id/plans/:jobId": "ai_studio.tests.delete",
    "POST /api/projects/:id/plans/:jobId/create": "ai_studio.tests.generate",
    "GET /api/projects/:id/framework-settings": "read",
    "PUT /api/projects/:id/framework-settings": "ai_studio.project.settings",
    "DELETE /api/projects/:id/restore-needs": "ai_studio.project.settings",
    // The whole project in one file, stored secrets included (encrypted): platform settings, like restoring one.
    "GET /api/projects/:id/backup": "ai_studio.platform.settings",

    // ── test data, environments, test accounts (the application under test's own credentials) ──
    "GET /api/projects/:id/test-data": "read",
    "POST /api/projects/:id/test-data": "ai_studio.tests.write",
    "GET /api/projects/:id/test-data/:name": "read",
    "PUT /api/projects/:id/test-data/:name": "ai_studio.tests.write",
    "DELETE /api/projects/:id/test-data/:name": "ai_studio.tests.delete",
    // test files for upload steps and the test data reset before a run (routes/web-pages.ts)
    "GET /api/projects/:id/test-files": "read",
    "POST /api/projects/:id/test-files": "ai_studio.tests.write",
    "DELETE /api/projects/:id/test-files/:name": "ai_studio.tests.delete",
    "GET /api/projects/:id/test-data-reset": "read",
    "PUT /api/projects/:id/test-data-reset": "ai_studio.project.settings",
    "DELETE /api/projects/:id/test-data-reset": "ai_studio.project.settings",
    "POST /api/projects/:id/test-data-reset/try": "ai_studio.tests.run",
    "GET /api/projects/:id/environments": "read",
    "POST /api/projects/:id/environments": "ai_studio.project.settings",
    "PUT /api/projects/:id/environments/:name": "ai_studio.project.settings",
    "DELETE /api/projects/:id/environments/:name": "ai_studio.project.settings",
    "PUT /api/projects/:id/environments/:name/secrets": "ai_studio.project.settings",
    "POST /api/projects/:id/environments/:name/default": "ai_studio.project.settings",
    "POST /api/projects/:id/environments/:name/runs": "ai_studio.tests.run",
    "GET /api/projects/:id/environments/:name/results": "read",
    "GET /api/projects/:id/roles": "read",
    "PUT /api/projects/:id/roles": "ai_studio.project.settings",
    // hard sign-ins (routes/hard-signin.ts): saved sessions follow the test accounts; the mailbox reaches another system
    "GET /api/projects/:id/hard-sign-in": "read",
    "POST /api/projects/:id/sessions/:account/capture": "ai_studio.project.settings",
    "GET /api/projects/:id/sessions/capture": "read",
    "POST /api/projects/:id/sessions/capture/save": "ai_studio.project.settings",
    "DELETE /api/projects/:id/sessions/capture": "ai_studio.project.settings",
    "PUT /api/projects/:id/sessions/:account": "ai_studio.project.settings",
    "POST /api/projects/:id/sessions/:account/check": "ai_studio.project.settings",
    "DELETE /api/projects/:id/sessions/:account": "ai_studio.project.settings",
    "PUT /api/projects/:id/mailbox": "ai_studio.ai_keys.manage",
    "POST /api/projects/:id/mailbox/test": "ai_studio.ai_keys.manage",
    "DELETE /api/projects/:id/mailbox": "ai_studio.ai_keys.manage",
    "POST /api/inbound-mail/:token": "public", // the address token is the credential, checked by the route itself (by hash)

    // ── schedules, alerts, deploy triggers, run sequences ──
    "GET /api/projects/:id/schedules": "read",
    "POST /api/projects/:id/schedules": "ai_studio.tests.run",
    "PATCH /api/projects/:id/schedules/:sid": "ai_studio.tests.run",
    "DELETE /api/projects/:id/schedules/:sid": "ai_studio.tests.run",
    "POST /api/projects/:id/schedules/:sid/run": "ai_studio.tests.run",
    "PUT /api/projects/:id/schedules/:sid/runbook": "ai_studio.tests.run",
    // Alert channels hold webhook addresses and mail passwords of other systems.
    "GET /api/projects/:id/alert-channels": "read",
    "POST /api/projects/:id/alert-channels": "ai_studio.ai_keys.manage",
    "PATCH /api/projects/:id/alert-channels/:cid": "ai_studio.ai_keys.manage",
    "DELETE /api/projects/:id/alert-channels/:cid": "ai_studio.ai_keys.manage",
    "POST /api/projects/:id/alert-channels/:cid/test": "ai_studio.ai_keys.manage",
    "GET /api/projects/:id/alert-options": "read",
    "GET /api/projects/:id/alert-log": "read",
    // A deploy-trigger token lets a pipeline start runs without the access key.
    "GET /api/projects/:id/triggers": "read",
    "POST /api/projects/:id/triggers": "ai_studio.ai_keys.manage",
    "DELETE /api/projects/:id/triggers/:tid": "ai_studio.ai_keys.manage",
    "PUT /api/projects/:id/triggers/:tid/runbook": "ai_studio.ai_keys.manage",
    "GET /api/projects/:id/runbooks": "read",
    "POST /api/projects/:id/runbooks": "ai_studio.tests.write",
    "POST /api/projects/:id/runbooks/from-template": "ai_studio.tests.write",
    "GET /api/projects/:id/runbooks/:rid": "read",
    "PUT /api/projects/:id/runbooks/:rid": "ai_studio.tests.write",
    "DELETE /api/projects/:id/runbooks/:rid": "ai_studio.tests.delete",
    "POST /api/projects/:id/runbooks/:rid/run": "ai_studio.tests.run",
    "GET /api/projects/:id/runbooks/:rid/runs": "read",
    "GET /api/projects/:id/runbooks/:rid/runs/:runId": "read",
    "POST /api/projects/:id/runbooks/:rid/runs/:runId/cancel": "ai_studio.tests.run",
    "GET /api/projects/:id/runbook-runs/:runId": "read",

    // ── runners (their tokens and kits are credentials) ──
    "GET /api/projects/:id/agents": "read",
    "GET /api/projects/:id/agent-tokens": "ai_studio.runners.manage",
    "POST /api/projects/:id/agent-tokens": "ai_studio.runners.manage",
    "DELETE /api/projects/:id/agent-tokens/:tid": "ai_studio.runners.manage",
    "GET /api/projects/:id/runner": "read",
    "PUT /api/projects/:id/runner": "ai_studio.project.settings",
    "POST /api/projects/:id/runner-kits": "ai_studio.runners.manage",
    "GET /api/projects/:id/runner-kits/info": "read",
    // runner updates (routes/runner-updates.ts): turning automatic updates off or asking one runner to update is managing runners
    "PUT /api/projects/:id/agents/:agentId/updates": "ai_studio.runners.manage",
    "POST /api/projects/:id/agents/:agentId/update": "ai_studio.runners.manage",
    // Runners as machines of an organisation (routes/runners.ts, round 34): reading is narrowed by the handler; changing one is also limited there to its owner's side.
    "GET /api/runners": "read",
    "GET /api/runners/summary": "read",
    "GET /api/runners/:runnerId": "read",
    "POST /api/runners": "ai_studio.runners.manage",
    "PATCH /api/runners/:runnerId": "ai_studio.runners.manage",
    "POST /api/runners/:runnerId/retire": "ai_studio.runners.manage",
    "GET /api/projects/:id/runner-access": "read",
    "PUT /api/projects/:id/runner-access/:runnerId": "ai_studio.runners.manage",
    "DELETE /api/projects/:id/runner-access/:runnerId": "ai_studio.runners.manage",

    // ── issue trackers, Sentry (tokens of other systems) ──
    "GET /api/projects/:id/integrations": "read",
    "POST /api/projects/:id/integrations": "ai_studio.ai_keys.manage",
    "PATCH /api/integrations/:id": "ai_studio.ai_keys.manage",
    "DELETE /api/integrations/:id": "ai_studio.ai_keys.manage",
    "POST /api/integrations/:id/test": "ai_studio.ai_keys.manage",
    "GET /api/projects/:id/sentry": "read",
    "PUT /api/projects/:id/sentry": "ai_studio.ai_keys.manage",
    "DELETE /api/projects/:id/sentry": "ai_studio.ai_keys.manage",
    "POST /api/projects/:id/sentry/test": "ai_studio.ai_keys.manage",
    // Integrations set up once for an organisation (routes/shared-integrations.ts): setting one up is managing connections to other systems,
    // the code that guards the same connections inside a project (the handler keeps a customer to their organisation); which projects use
    // it is a project setting. Reading is narrowed by the handler.
    "GET /api/shared-integrations": "read",
    "POST /api/shared-integrations": "ai_studio.ai_keys.manage",
    "PATCH /api/shared-integrations/:sid": "ai_studio.ai_keys.manage",
    "DELETE /api/shared-integrations/:sid": "ai_studio.ai_keys.manage",
    "POST /api/shared-integrations/:sid/test": "ai_studio.ai_keys.manage",
    "GET /api/projects/:id/shared-integrations": "read",
    "PUT /api/projects/:id/shared-integrations/:sid": "ai_studio.project.settings",
    "DELETE /api/projects/:id/shared-integrations/:sid": "ai_studio.project.settings",

    // ── storage, retention, AI budget ──
    "GET /api/projects/:id/retention": "read",
    "PUT /api/projects/:id/retention": "ai_studio.platform.settings",
    "POST /api/projects/:id/retention/preview": "ai_studio.project.settings",
    "POST /api/projects/:id/retention/run": "ai_studio.platform.settings",
    "GET /api/projects/:id/usage-budget": "ai_studio.usage.view",
    "PUT /api/projects/:id/usage-budget": "ai_studio.platform.settings",

    // ── manual cases and releases ──
    "GET /api/projects/:id/manual-cases": "read",
    "POST /api/projects/:id/manual-cases": "ai_studio.tests.write",
    "POST /api/projects/:id/manual-cases/import": "ai_studio.tests.write",
    // The AI writes a test script for each chosen written case (routes/generate-scripts.ts): using the AI to write tests, like every AI
    // route; it saves them too, so the handler also asks for ai_studio.tests.write (this table takes one permission).
    "POST /api/projects/:id/manual-cases/generate-scripts": "ai_studio.tests.generate",
    "GET /api/projects/:id/manual-cases/export": "ai_studio.reports.export",
    "GET /api/projects/:id/manual-cases/:cid": "read",
    "PUT /api/projects/:id/manual-cases/:cid": "ai_studio.tests.write",
    "DELETE /api/projects/:id/manual-cases/:cid": "ai_studio.tests.delete",
    // Requirements as records and the tests that cover them (routes/requirements.ts). Refining an import with the AI spends tokens.
    "GET /api/projects/:id/requirements": "read",
    "POST /api/projects/:id/requirements": "ai_studio.tests.write",
    "GET /api/projects/:id/requirements/coverage": "read",
    "GET /api/projects/:id/requirements/links": "read",
    "POST /api/projects/:id/requirements/import/preview": "ai_studio.tests.write",
    "POST /api/projects/:id/requirements/import/refine": "ai_studio.tests.generate",
    "POST /api/projects/:id/requirements/import": "ai_studio.tests.write",
    // Written test cases from chosen requirements, by the AI model (routes/requirements.ts): the AI's permission, as import/refine; the
    // handler also asks for ai_studio.tests.write, since the cases are saved.
    "POST /api/projects/:id/requirements/generate-cases": "ai_studio.tests.generate",
    "GET /api/projects/:id/requirements/:rid": "read",
    "PATCH /api/projects/:id/requirements/:rid": "ai_studio.tests.write",
    "DELETE /api/projects/:id/requirements/:rid": "ai_studio.tests.write",
    "POST /api/projects/:id/requirements/:rid/tests": "ai_studio.tests.write",
    "DELETE /api/projects/:id/requirements/:rid/tests/:testId": "ai_studio.tests.write",
    "GET /api/tests/:id/requirements": "read",
    "GET /api/projects/:id/releases": "read",
    "POST /api/projects/:id/releases": "ai_studio.tests.run",
    "GET /api/projects/:id/releases/:rid": "read",
    "POST /api/projects/:id/releases/:rid/refresh": "ai_studio.tests.run",
    "PUT /api/projects/:id/releases/:rid/results/:cid": "ai_studio.tests.run",
    "POST /api/projects/:id/releases/:rid/results/:cid/issue": "ai_studio.tests.run",
    "POST /api/projects/:id/releases/:rid/reopen": "ai_studio.tests.run",
    "GET /api/projects/:id/releases/:rid/report": "ai_studio.reports.export",
    "POST /api/projects/:id/releases/:rid/signoff": "ai_studio.tests.run",

    // ── quarantine ──
    "GET /api/projects/:id/quarantine": "read",
    "POST /api/projects/:id/quarantine": "ai_studio.tests.write",
    "GET /api/projects/:id/quarantine/suggestions": "read",
    "GET /api/projects/:id/quarantine/history": "read",
    "POST /api/projects/:id/quarantine/:qid/release": "ai_studio.tests.write",
    "POST /api/projects/:id/quarantine/:qid/review": "ai_studio.tests.write",

    // ── shared elements, reusable steps, helpers, imports, new tests ──
    "GET /api/projects/:id/objects": "read",
    "POST /api/projects/:id/objects": "ai_studio.tests.write",
    "GET /api/projects/:id/objects/export": "ai_studio.reports.export",
    "POST /api/projects/:id/objects/extract": "ai_studio.tests.write",
    "POST /api/projects/:id/objects/import": "ai_studio.tests.write",
    "GET /api/projects/:id/objects/:oid": "read",
    "PUT /api/projects/:id/objects/:oid": "ai_studio.tests.write",
    "DELETE /api/projects/:id/objects/:oid": "ai_studio.tests.delete",
    "GET /api/projects/:id/blocks": "read",
    "POST /api/projects/:id/blocks": "ai_studio.tests.write",
    "POST /api/projects/:id/blocks/from-steps": "ai_studio.tests.write",
    "GET /api/projects/:id/blocks/:name": "read",
    "PUT /api/projects/:id/blocks/:name": "ai_studio.tests.write",
    "DELETE /api/projects/:id/blocks/:name": "ai_studio.tests.delete",
    "GET /api/projects/:id/blocks/:name/usage": "read",
    "GET /api/projects/:id/helpers": "read",
    "GET /api/projects/:id/helpers/:name": "read",
    "PUT /api/projects/:id/helpers/:name": "ai_studio.tests.write",
    "DELETE /api/projects/:id/helpers/:name": "ai_studio.tests.delete",
    "GET /api/projects/:id/git-imports": "read",
    "POST /api/projects/:id/git-imports": "ai_studio.tests.write",
    "DELETE /api/projects/:id/git-imports/:gid": "ai_studio.tests.delete",
    "POST /api/projects/:id/git-imports/:gid/check": "ai_studio.tests.write",
    "POST /api/projects/:id/git-imports/:gid/refresh": "ai_studio.tests.write",
    "POST /api/projects/:id/import/maestro": "ai_studio.tests.write",
    "POST /api/projects/:id/custom-tests": "ai_studio.tests.write",
    "POST /api/projects/:id/dsl-tests": "ai_studio.tests.write",
    "POST /api/projects/:id/plain-tests": "ai_studio.tests.generate",
    "POST /api/projects/:id/built-tests": "ai_studio.tests.write",
    "POST /api/projects/:id/recordings": "ai_studio.tests.write",
    "GET /api/projects/:id/live-sessions": "read",

    // ── recordings and live sessions ──
    "GET /api/recordings/:rid": "read",
    "DELETE /api/recordings/:rid": "ai_studio.tests.delete",
    "POST /api/recordings/:rid/inspect": "ai_studio.tests.write",
    "PATCH /api/recordings/:rid/steps/:index": "ai_studio.tests.write",
    "DELETE /api/recordings/:rid/steps/:index": "ai_studio.tests.write",
    "POST /api/recordings/:rid/steps/:index/share": "ai_studio.tests.write",
    "POST /api/recordings/:rid/stop": "ai_studio.tests.write",
    "POST /api/recordings/:rid/save": "ai_studio.tests.write",
    "GET /api/recordings/:rid/snapshot": "read",
    "POST /api/recordings/:rid/act": "ai_studio.agent.run",

    // ── jobs ──
    "GET /api/test-generation/:jobId": "read",
    "DELETE /api/test-generation/:jobId": "ai_studio.tests.run",
    "GET /api/test-generation/:jobId/events": "read",
    "GET /api/test-generation/:jobId/stream": "read",

    // ── one test ──
    "GET /api/tests/:id": "read",
    "POST /api/tests/:id/baseline": "ai_studio.tests.write",
    "POST /api/tests/:id/validate": "ai_studio.tests.run",
    "POST /api/tests/:id/variants": "ai_studio.tests.run",
    "GET /api/tests/:id/executions": "read",
    "GET /api/tests/:id/evidence": "read",
    "GET /api/tests/:id/script": "read",
    "GET /api/tests/:id/download": "ai_studio.reports.export",
    "PUT /api/tests/:id/script": "ai_studio.tests.write",
    "POST /api/tests/:id/scripts": "ai_studio.tests.write",
    // Checks a script against the guard rules; nothing is stored.
    "POST /api/tests/:id/script/check": "read",
    "GET /api/tests/:id/script-versions": "read",
    "GET /api/tests/:id/script-versions/:version": "read",
    "POST /api/tests/:id/script-versions/:version/restore": "ai_studio.tests.write",
    "GET /api/tests/:id/sentry": "read",
    "POST /api/tests/:id/steps/:index/share": "ai_studio.tests.write",
    "GET /api/tests/:id/spec": "read",
    "PUT /api/tests/:id/spec": "ai_studio.tests.write",
    // Shows what a change of steps would do; nothing is stored.
    "POST /api/tests/:id/spec/preview": "read",
    "GET /api/tests/:id/spec-versions": "read",
    "GET /api/tests/:id/spec-versions/:version": "read",
    "POST /api/tests/:id/issue": "ai_studio.tests.write",
    "GET /api/tests/:id/issues": "read",
    "GET /api/tests/:id/performance": "read",
    "POST /api/tests/:id/plain-rewrite": "ai_studio.tests.generate",
    "GET /api/tests/:id/healing": "read",
    "POST /api/tests/:id/healing/:pid/dismiss": "ai_studio.tests.write",
    "POST /api/tests/:id/healing/:pid/apply": "ai_studio.tests.write",
    "GET /api/tests/:id/cleanup": "read",
    "GET /api/tests/:id/quarantine": "read",
    "GET /api/tests/:id/take-over": "read",
    "POST /api/tests/:id/take-over": "ai_studio.tests.write",
    "POST /api/tests/:id/restore-generated": "ai_studio.tests.write",
    "GET /api/tests/:id/dsl": "read",
    "PUT /api/tests/:id/dsl": "ai_studio.tests.write",

    // ── added in round 16 by other features ──
    // Production hosting (INF): outside /api/, each with its own rule (open health checks; metrics need the key or METRICS_TOKEN).
    "GET /healthz": "own",
    "GET /readyz": "own",
    "GET /metrics": "own",
    // AI model reliability (LLM): a check is one small paid call; the fallback models are a platform-wide setting.
    // AI configuration (routes/ai-config.ts): the project's answer is narrowed by the handler; keys need "manage keys", and the handler limits a customer to their organisation
    "GET /api/projects/:id/ai": "read",
    "PUT /api/projects/:id/ai": "ai_studio.ai_keys.manage",
    "POST /api/projects/:id/ai/configurations": "ai_studio.ai_keys.manage",
    "GET /api/ai-configurations": "ai_studio.ai_keys.manage",
    "POST /api/ai-configurations": "ai_studio.ai_keys.manage",
    "PATCH /api/ai-configurations/:configId": "ai_studio.ai_keys.manage",
    "DELETE /api/ai-configurations/:configId": "ai_studio.ai_keys.manage",
    "POST /api/ai-configurations/:configId/test": "ai_studio.ai_keys.manage",
    "GET /api/llm/health": "read",
    "POST /api/llm/check": "ai_studio.tests.generate",
    "PUT /api/llm/fallbacks": "ai_studio.platform.settings",
    // Smaller page snapshots (SNAP): a platform-wide AI setting, like the fallback models.
    "GET /api/llm/compact-snapshots": "read",
    "PUT /api/llm/compact-snapshots": "ai_studio.platform.settings",
    // Prompt caching (CACHE): a platform-wide AI setting, like the fallback models.
    "GET /api/llm/prompt-cache": "read",
    "PUT /api/llm/prompt-cache": "ai_studio.platform.settings",
    // Fast model for routine steps (ROUTE): a platform-wide AI setting, like the fallback models.
    "GET /api/llm/fast-model": "read",
    "PUT /api/llm/fast-model": "ai_studio.platform.settings",
    // Repair without AI first and exploration reuse (DET): platform-wide AI settings, like the fallback models.
    "GET /api/llm/without-ai": "read",
    "PUT /api/llm/without-ai": "ai_studio.platform.settings",
    // Evaluation runs (EV): an evaluation spends AI tokens across whole apps.
    "GET /api/eval/runs": "read",
    "GET /api/eval/runs/:id": "read",
    "POST /api/eval/runs": "ai_studio.platform.settings",
    "DELETE /api/eval/runs/:id": "ai_studio.platform.settings",
    // Device farms (PC): provider credentials are keys of another system; choosing where phone tests run is a project setting.
    "GET /api/projects/:id/device-farms": "read",
    "GET /api/projects/:id/device-farms/sessions": "read",
    "POST /api/projects/:id/device-farms": "ai_studio.ai_keys.manage",
    "PUT /api/projects/:id/device-farms/:farmId": "ai_studio.ai_keys.manage",
    "DELETE /api/projects/:id/device-farms/:farmId": "ai_studio.ai_keys.manage",
    "POST /api/projects/:id/device-farms/:farmId/check": "ai_studio.ai_keys.manage",
    "PUT /api/projects/:id/device-farm-choice": "ai_studio.project.settings",
    // Phone reliability (PR): the app's runtime permissions, read from the device.
    "GET /api/projects/:id/mobile-app/permissions": "read",
    // Phones (round 24, DEVICE: routes/phone-device.ts): reading settings and the ready check is reading; changing a setting, a phone's
    // animations or stay-awake (reversible) is a project setting; answering an exploration that waits for a one-time code is generating, like starting one.
    "GET /api/projects/:id/phone-settings": "read",
    "PUT /api/projects/:id/phone-settings": "ai_studio.project.settings",
    "GET /api/projects/:id/phones": "read",
    "POST /api/projects/:id/phones/:serial/animations": "ai_studio.project.settings",
    "POST /api/projects/:id/phones/:serial/stay-awake": "ai_studio.project.settings",
    "GET /api/projects/:id/jobs/:jobId/phone-sign-in": "read",
    "POST /api/projects/:id/jobs/:jobId/phone-sign-in": "ai_studio.tests.generate",

    // ── Security Assessment module (src/security, round 18): reading is reading, registering and running is security.use; authorizations are approvals ──
    // CORE (src/security/routes/core.ts)
    "GET /api/v1/security/status": "read",
    "GET /api/v1/security/projects/:id/applications": "read",
    "POST /api/v1/security/projects/:id/applications": "ai_studio.security.use",
    "GET /api/v1/security/applications/:appId": "read",
    "PATCH /api/v1/security/applications/:appId": "ai_studio.security.use",
    "DELETE /api/v1/security/applications/:appId": "ai_studio.platform.settings",
    "GET /api/v1/security/applications/:appId/authorizations": "read",
    // The client's permission to assess is a sign-off (owners only on a local install); removing an application drops its audit history.
    "POST /api/v1/security/applications/:appId/authorizations": "ai_studio.tests.approve",
    "DELETE /api/v1/security/authorizations/:authId": "ai_studio.tests.approve",
    "GET /api/v1/security/projects/:id/activity": "read",
    "GET /api/v1/security/projects/:id/testing-type": "read",
    "PUT /api/v1/security/projects/:id/testing-type": "ai_studio.security.use",
    // RUN (assessments) and FIND (findings, reports): add their rules below.
    // RUN (src/security/routes/assessments.ts): starting, cancelling and the emergency stop are security.use.
    "POST /api/v1/security/applications/:appId/assessments": "ai_studio.security.use",
    "GET /api/v1/security/projects/:id/assessments": "read",
    "GET /api/v1/security/assessments/:aid": "read",
    "POST /api/v1/security/assessments/:aid/cancel": "ai_studio.security.use",
    "POST /api/v1/security/projects/:id/stop-all": "ai_studio.security.use",
    // FIND (src/security/routes/findings.ts): report downloads are reports.export; validating and entering findings is security.use
    // (marking a finding an accepted risk additionally needs tests.approve, checked in the route).
    "GET /api/v1/security/projects/:id/findings": "read",
    "GET /api/v1/security/findings/:fid": "read",
    "PATCH /api/v1/security/findings/:fid": "ai_studio.security.use",
    "POST /api/v1/security/applications/:appId/findings": "ai_studio.security.use",
    "GET /api/v1/security/projects/:id/overview": "read",
    "GET /api/v1/security/assessments/:aid/report": "ai_studio.reports.export",
    "GET /api/v1/security/projects/:id/report": "ai_studio.reports.export",
    // OPS (src/security/routes/notifications.ts): the project's messages when an assessment ends; changing them is security.use (the
    // channels themselves are keys of other systems, under Schedule, Alerts).
    "GET /api/v1/security/projects/:id/notifications": "read",
    "PUT /api/v1/security/projects/:id/notifications": "ai_studio.security.use",
    // SIGN (src/security/routes/signin.ts): saving a sign-in and uploading or removing the API document are security.use. Choosing the sign-in and the sensitive workflows go through PATCH above.
    "GET /api/v1/security/projects/:id/sign-ins": "read",
    "PUT /api/v1/security/applications/:appId/saved-sign-in": "ai_studio.security.use",
    "GET /api/v1/security/applications/:appId/api-document": "read",
    "PUT /api/v1/security/applications/:appId/api-document": "ai_studio.security.use",
    "DELETE /api/v1/security/applications/:appId/api-document": "ai_studio.security.use",
    // SCAN (src/security/routes/scanners.ts): allowing a scanner for this project is security.use.
    // Nothing here starts a scan: a scan runs inside an assessment, under that assessment's authorization.
    "GET /api/v1/security/projects/:id/scanners": "read",
    "PUT /api/v1/security/projects/:id/scanners": "ai_studio.security.use",
    "GET /api/v1/security/projects/:id/scans": "read",
    "GET /api/v1/security/assessments/:aid/scans": "read",
    "GET /api/v1/security/scanners": "read",

    // ── a project's people and Project Admins (routes/members.ts, round 25) ──
    "GET /api/projects/:id/members": "ai_studio.project.members",
    "GET /api/projects/:id/members/candidates": "ai_studio.project.members",
    "POST /api/projects/:id/members": "ai_studio.project.members",
    "PATCH /api/projects/:id/members/:personId": "ai_studio.project.members",
    "DELETE /api/projects/:id/members/:personId": "ai_studio.project.members",

    // ── a project's general settings and the organisations (routes/project-settings.ts, round 26) ──
    "PATCH /api/projects/:id": "ai_studio.project.settings",
    // Testing agents: the catalogue and the agents a project uses (routes/testing-agents.ts, round 37).
    "GET /api/testing-agents": "read",
    "GET /api/testing-agents/:agentId": "read",
    "GET /api/projects/:id/testing-agents": "read",
    "PUT /api/projects/:id/testing-agents": "ai_studio.project.settings",
    // What the agents need (routes/agent-inputs.ts, round 38): reading the sign-in name is like reading the test accounts; saving is a setting.
    "GET /api/projects/:id/agent-inputs": "read",
    "PUT /api/projects/:id/agent-inputs": "ai_studio.project.settings",
    "GET /api/projects/:id/setup-check": "read",
    // Crowd4Test projects of the project's organisation: only for choosing the reference link (US-011).
    "GET /api/projects/:id/c4t-projects": "ai_studio.project.settings",
    // Narrowed by the handler: a customer's own organisation, all for staff, none for testers.
    "GET /api/organizations": "read",

    // ── review and approval of test versions, the scripts list and the review queue (routes/reviews.ts, round 34) ──
    "GET /api/projects/:id/scripts": "read",
    "GET /api/projects/:id/review-policy": "read",
    // Turning review off is an approver's call: it also needs Project Admin of the project (canApprove, checked in the route).
    "PUT /api/projects/:id/review-policy": "ai_studio.tests.approve",
    "GET /api/tests/:id/review": "read",
    "GET /api/tests/:id/review/:version": "read",
    "POST /api/tests/:id/review/:version/submit": "ai_studio.tests.write",
    // Approving, rejecting and asking for changes also need Project Admin of the project (canApprove, checked in the route).
    "POST /api/tests/:id/review/:version/approve": "ai_studio.tests.approve",
    "POST /api/tests/:id/review/:version/reject": "ai_studio.tests.approve",
    "POST /api/tests/:id/review/:version/request-changes": "ai_studio.tests.approve",
    // Commenting needs ai_studio.tests.write or canApprove in the project (checked in the route).
    "POST /api/tests/:id/review/:version/comments": "read",
    // Narrowed by the handler to the projects the caller may approve in.
    "GET /api/reviews": "read",
    "GET /api/jobs/:id/test-versions": "read",

    // ── project folders, archiving and deleting a project, a person's preferences (routes/project-folders.ts, round 34) ──
    // Folders: reading is narrowed by the handler; changing them is for people who create projects, in their own organisation (checked there).
    "GET /api/folders": "read",
    "POST /api/folders": "ai_studio.project.create",
    "PATCH /api/folders/:folderId": "ai_studio.project.create",
    "DELETE /api/folders/:folderId": "ai_studio.project.create",
    "PUT /api/projects/:id/folder": "ai_studio.project.create",
    // Archive, restore and delete also need Project Admin of the project (checked in the route).
    "POST /api/projects/:id/archive": "ai_studio.project.settings",
    "POST /api/projects/:id/unarchive": "ai_studio.project.settings",
    // Deleting also needs ai_studio.tests.delete in the project (checked in the route).
    "DELETE /api/projects/:id": "ai_studio.project.settings",
    "GET /api/me/preferences": "read",
    "PUT /api/me/preferences": "read",
    // ── reusable libraries of an organisation (routes/libraries.ts, round 37) ──
    // Reading is narrowed by the handler to the organisations the person works in. Changing a library also needs a place in the whole
    // organisation (checked there): a person of that organisation, a Crowd4Test administrator, or a local account with every project.
    "GET /api/libraries": "read",
    "POST /api/libraries/folders": "ai_studio.tests.write",
    "PATCH /api/libraries/folders/:folderId": "ai_studio.tests.write",
    "DELETE /api/libraries/folders/:folderId": "ai_studio.tests.delete",
    "POST /api/libraries/items": "ai_studio.tests.write",
    "GET /api/libraries/items/:itemId": "read",
    "PATCH /api/libraries/items/:itemId": "ai_studio.tests.write",
    "PUT /api/libraries/items/:itemId/content": "ai_studio.tests.write",
    "GET /api/libraries/items/:itemId/versions/:version": "read",
    "DELETE /api/libraries/items/:itemId": "ai_studio.tests.delete",
    // A project copying an item, updating its copy, or offering its own one to the library (publishing also needs the library rights above).
    "GET /api/projects/:id/library": "read",
    "POST /api/projects/:id/library/use": "ai_studio.tests.write",
    "POST /api/projects/:id/library/update": "ai_studio.tests.write",
    "POST /api/projects/:id/library/publish": "ai_studio.tests.write",
};

const key = (method: string, template: string) => `${method.toUpperCase() === "HEAD" ? "GET" : method.toUpperCase()} ${template}`;

/** The permission rule for a method and a route template ("/api/projects/:id"), or undefined when the table does not know it. */
export function permissionRuleFor(method: string, template: string): PermissionRule | undefined {
    return ROUTE_PERMISSIONS[key(method, template)];
}

const asRole = (rule: PermissionRule): Rule => (rule === "public" || rule === "own" ? rule : rule === "read" ? "viewer" : leastRoleFor(rule));

/** The same table in local-role words, derived (never edited by hand): what each route needs from an owner, editor or viewer. */
export const ROUTE_ROLES: Record<string, Rule> = Object.fromEntries(Object.entries(ROUTE_PERMISSIONS).map(([k, r]) => [k, asRole(r)]));

/** The local-role rule for a method and a route template, or undefined when the table does not know it. */
export function ruleFor(method: string, template: string): Rule | undefined {
    const r = permissionRuleFor(method, template);
    return r === undefined ? undefined : asRole(r);
}
