import { registerAgentRoutes } from "./agents.js";
import { registerAgentRunRoutes } from "./agent-runs.js";
import { registerRunnerRoutes } from "./runners.js";
import { registerAuthoringRoutes } from "./authoring.js";
import { registerBlockRoutes } from "./blocks.js";
import { registerCleanupRoutes } from "./cleanup.js";
import { registerContractRoutes } from "./contracts.js";
import { registerDashboardRoutes } from "./dashboard.js";
import { registerDslRoutes } from "./dsl.js";
import { registerGenerateScriptRoutes } from "./generate-scripts.js";
import { registerDeviceFarmRoutes } from "./device-farms.js";
import { registerCustomScriptRoutes } from "./custom-scripts.js";
import { registerEnvironmentRoutes } from "./environments.js";
import { registerEvidenceRoutes } from "./evidence.js";
import { registerExplorerRoutes } from "./explorer.js";
import { registerAuthRoutes } from "./auth.js";
import { registerUserRoutes } from "./users.js";
import { registerProjectAccessRoutes } from "./project-access.js";
import { registerMemberRoutes } from "./members.js";
import { registerProjectSettingsRoutes } from "./project-settings.js";
import { registerProjectFolderRoutes } from "./project-folders.js";
import { registerLibraryRoutes } from "./libraries.js";
import { registerLlmHealthRoutes } from "../llm-health-routes.js";
import { registerCompactSnapshotRoutes } from "../snapshot-settings.js";
import { registerPromptCacheRoutes } from "../prompt-cache-settings.js";
import { registerLlmRoutingRoutes } from "../llm-routing.js";
import { registerAiConfigRoutes } from "./ai-config.js";
import { registerWithoutAiRoutes } from "../without-ai-settings.js";
import { registerEmulatorSetupRoutes } from "../emulator-setup.js";
import { registerEvalRoutes } from "./eval.js";
import { registerFrameworkRoutes } from "./frameworks.js";
import { registerGitImportRoutes } from "./git-import.js";
import { registerSpecEditRoutes } from "./spec-edit.js";
import { registerHealingRoutes } from "./healing.js";
import { registerHardSignInRoutes } from "./hard-signin.js";
import { registerIdentityRoutes } from "./identity.js";
import { registerImportRoutes } from "./imports.js";
import { registerIntegrationRoutes } from "./integrations.js";
import { registerMemoryRoutes } from "./memory.js";
import { registerNotesRoutes } from "./notes.js";
import { registerOpsRoutes } from "./ops.js";
import { registerLocatorRoutes } from "./locators.js";
import { registerManualCaseRoutes } from "./manual-cases.js";
import { registerRequirementRoutes } from "./requirements.js";
import { registerPerformanceRoutes } from "./performance.js";
import { registerPlanRoutes } from "./plans.js";
import { registerQuarantineRoutes } from "./quarantine.js";
import { registerLiveSessionRoutes } from "./live-session.js";
import { registerRecorderRoutes } from "./recorder.js";
import { registerReportRoutes } from "./reports.js";
import { registerSentryRoutes } from "./sentry.js";
import { registerSharedIntegrationRoutes } from "./shared-integrations.js";
import { registerUsageRoutes } from "./usage.js";
import { registerStreamRoutes } from "./stream.js";
import { registerTriggerRoutes } from "./triggers.js";
import { registerRetentionRoutes } from "./retention.js";
import { registerRunbookRoutes } from "./runbooks.js";
import { registerRunnerKitRoutes } from "./runner-kits.js";
import { registerRunnerUpdateRoutes } from "./runner-updates.js";
import { registerRunRoutes } from "./runs.js";
import { registerScheduleRoutes } from "./schedules.js";
import { registerSuiteRoutes } from "./suites.js";
import type { RouteCtx } from "./types.js";
import { registerVariantRoutes } from "./variants.js";
import { registerWebPageRoutes } from "./web-pages.js";
import { registerPhoneStateRoutes } from "./phone-state.js";
import { registerPhoneDeviceRoutes } from "./phone-device.js";
import { registerPortableRoutes } from "./portable.js";
import { registerReviewRoutes } from "./reviews.js";
import { registerTestingAgentRoutes } from "./testing-agents.js";
import { registerAgentInputRoutes } from "./agent-inputs.js";
import { registerSecurityRoutes } from "../../security/routes/index.js";

export type { RouteCtx } from "./types.js";

/** Feature route modules, registered by the core server after its own routes. Each module owns its own file. */
export function registerFeatureRoutes(ctx: RouteCtx): void {
    // Health, readiness, metrics and request ids (outside /api/; its hooks see every request): routes/ops.ts.
    registerOpsRoutes(ctx);
    registerVariantRoutes(ctx);
    registerScheduleRoutes(ctx);
    registerIntegrationRoutes(ctx);
    registerPerformanceRoutes(ctx);
    registerContractRoutes(ctx);
    registerIdentityRoutes(ctx);
    registerHardSignInRoutes(ctx);
    registerReportRoutes(ctx);
    registerMemoryRoutes(ctx);
    // Notes for the AI, written by people (routes/notes.ts, round 53).
    registerNotesRoutes(ctx);
    registerEnvironmentRoutes(ctx);
    registerHealingRoutes(ctx);
    registerTriggerRoutes(ctx);
    registerCleanupRoutes(ctx);
    registerDashboardRoutes(ctx);
    registerAuthoringRoutes(ctx);
    registerImportRoutes(ctx);
    registerEvidenceRoutes(ctx);
    registerRunbookRoutes(ctx);
    registerManualCaseRoutes(ctx);
    // Requirements as records and the tests that cover them (routes/requirements.ts).
    registerRequirementRoutes(ctx);
    registerSentryRoutes(ctx);
    // Integrations set up once for an organisation, and the projects that use them (routes/shared-integrations.ts).
    registerSharedIntegrationRoutes(ctx);
    registerRetentionRoutes(ctx);
    registerUsageRoutes(ctx);
    registerQuarantineRoutes(ctx);
    registerAgentRoutes(ctx);
    registerRunnerRoutes(ctx);
    registerRunnerKitRoutes(ctx);
    registerRunnerUpdateRoutes(ctx);
    registerLocatorRoutes(ctx);
    registerFrameworkRoutes(ctx);
    registerStreamRoutes(ctx);
    registerRecorderRoutes(ctx);
    registerLiveSessionRoutes(ctx);
    registerCustomScriptRoutes(ctx);
    registerGitImportRoutes(ctx);
    registerSpecEditRoutes(ctx);
    registerBlockRoutes(ctx);
    registerDslRoutes(ctx);
    // "Generate test scripts using AI": written cases into AI draft scripts (routes/generate-scripts.ts, round 38).
    registerGenerateScriptRoutes(ctx);
    registerDeviceFarmRoutes(ctx);
    // Phone start state: the app's permissions for the "Grant these permissions" checklist (routes/phone-state.ts).
    registerPhoneStateRoutes(ctx);
    // Phone settings, "Is this phone ready?", reversible phone changes, the sign-in pause (round 24, DEVICE).
    registerPhoneDeviceRoutes(ctx);
    registerRunRoutes(ctx);
    // Test suites a person builds: ordered tests, how they run, runs and schedules (routes/suites.ts).
    registerSuiteRoutes(ctx);
    registerAgentRunRoutes(ctx);
    // Review and approval of test versions, the scripts list and the review queue (routes/reviews.ts).
    registerReviewRoutes(ctx);
    registerPlanRoutes(ctx);
    registerExplorerRoutes(ctx);
    // People and access: signing in, a person's own account, people, activity, single sign-on (routes/auth.ts, routes/users.ts).
    registerAuthRoutes(ctx);
    registerUserRoutes(ctx);
    // Per-project access: which projects a person may see (routes/project-access.ts; the check is auth/project-scope.ts).
    registerProjectAccessRoutes(ctx);
    // A project's people and Project Admins (routes/members.ts, round 25: ACCESS_MODEL.md).
    registerMemberRoutes(ctx);
    registerProjectSettingsRoutes(ctx);
    registerProjectFolderRoutes(ctx);
    // Testing agents and the agents chosen for a project (routes/testing-agents.ts, round 37).
    registerTestingAgentRoutes(ctx);
    // What a project's testing agents need, kept on its Requirements tab (routes/agent-inputs.ts, round 38).
    registerAgentInputRoutes(ctx);
    // Reusable libraries of an organisation, and a project using and publishing their items (routes/libraries.ts, round 37).
    registerLibraryRoutes(ctx);
    registerLlmHealthRoutes(ctx);
    // Smaller page snapshots switch, Settings, AI model (platform/snapshot-settings.ts, docs/features/smaller-snapshots.md).
    registerCompactSnapshotRoutes(ctx);
    // Prompt caching switch, Settings, AI model (platform/prompt-cache-settings.ts, docs/features/prompt-caching.md).
    registerPromptCacheRoutes(ctx);
    // Fast model for routine steps, Settings, AI model (platform/llm-routing.ts, docs/features/model-routing.md).
    registerLlmRoutingRoutes(ctx);
    // Who pays for a project's AI, which configuration it uses, and the keys (routes/ai-config.ts).
    registerAiConfigRoutes(ctx);
    // Repair without AI first and exploration reuse, Settings, AI model (platform/without-ai-settings.ts, docs/features/repair-and-reuse-without-ai.md).
    registerWithoutAiRoutes(ctx);
    // Downloadable "set up the Android emulator" script, Settings, Mobile testing (platform/emulator-setup.ts, docs/features/emulator-setup.md).
    registerEmulatorSetupRoutes(ctx);
    registerEvalRoutes(ctx);
    // Test files for upload steps and the test data reset before a run (routes/web-pages.ts).
    registerWebPageRoutes(ctx);
    // One test as a folder that runs on its own computer (routes/portable.ts, docs/features/portable-code-tests.md).
    registerPortableRoutes(ctx);
    // Security Assessment module, /api/v1/security (src/security/routes/index.ts, docs/features/security-assessment.md).
    registerSecurityRoutes(ctx);
}
