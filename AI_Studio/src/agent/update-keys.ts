/**
 * The public keys a runner trusts for its own updates (docs/features/runner-updates.md, "Signed updates"). Built into runner.mjs, so a
 * runner never takes a key from the platform it updates from.
 *
 * Each entry is the raw 32-byte Ed25519 public key, base64. The matching private key lives only in the deploy workflow's secret
 * RUNNER_UPDATE_SIGNING_KEY. To make the pair, run once, on your own computer:
 *
 *   node scripts/sign-runner-update.mjs --new-key runner-update-signing-key.pem
 *
 * It writes the private key to that file (readable only by you) and prints the line to paste below. Store the file's contents as the
 * repository secret RUNNER_UPDATE_SIGNING_KEY, then delete the file. To change keys, add the new public key here first, deploy, let the
 * runners update, then sign with the new key and remove the old line.
 *
 * Empty: this build installs no update by itself; a person downloads each new version (Settings, Your runner says so).
 */
export const PINNED_UPDATE_KEYS: readonly string[] = [
    "ozFWHiNi0T3NeSH7ijT+8q4aJAZfvrAtt6hiHij5kPc=", // key 134d4136f40865a2
];

/** Replaced at build time only by tests (scripts/build-runner.mjs `updateKeys`), so a test build can trust a test key. */
declare const __AITP_UPDATE_KEYS__: readonly string[] | undefined;

export const UPDATE_KEYS: readonly string[] = typeof __AITP_UPDATE_KEYS__ !== "undefined" ? __AITP_UPDATE_KEYS__ : PINNED_UPDATE_KEYS;
