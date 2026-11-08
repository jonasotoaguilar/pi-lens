/**
 * #4589 admission reasons: WHY each baseline row is admitted.
 *
 * `test-env-restore-baseline.ts` says which writes are not provably restored.
 * This file says why, one entry per admitted file, and the sweep re-checks the
 * claim against the file's own source (`describe` mechanism rows in
 * `tests/config/test-env-restore-sweep.test.ts`). The split is AGENTS.md shape
 * 38: a baseline row needs a reason in a separate checked file, or a new leak
 * is admitted by appending one line.
 *
 * The mechanisms are the ways a file CAN restore a key without the detector
 * attributing it to the write:
 *
 * - `teardown`: the file declares `afterEach`/`afterAll` (or, for a
 *   `vi.stubEnv` row, `vi.unstubAllEnvs`), and the hook does not cover this
 *   write: it sits in a sibling `describe`, in a file-local helper called from
 *   tests, or in a loop whose iterable the file builds at run time;
 * - `finally`: the file puts the key back in a `finally`, but in another
 *   function than the write's;
 * - `helper`: the file returns a restore closure (or builds one with
 *   `withEnv`) that its caller must invoke;
 * - `module-pin`: a module-scope or `vi.hoisted` assignment set before a
 *   dynamic import, which no per-case hook can restore;
 * - `none`: nothing in the file restores this key. These rows are REAL leaks
 *   the ratchet holds until a fix restores them, and the check is falsifiable:
 *   a stub row needs no `vi.unstubAllEnvs` anywhere, and a plain write no
 *   hook, `finally`, or returned restore closure at all.
 *
 * A file's admitted mechanism must be one the sweep re-derives from its
 * source by the detector's own classifier (`envRestoreMechanisms`), so a
 * module-pinned write cannot be recorded as `teardown`.
 */

import type { EnvRestoreMechanism } from "./test-env-restore-gate.js";

/** Why one admitted file's rows sit in the baseline. */
export interface EnvRestoreAdmission {
	mechanism: EnvRestoreMechanism;
	/** What in this file restores the key, and why the detector misses it. */
	reason: string;
}

/**
 * Keyed by file, because two suites in one file share the mechanism; a row
 * with no entry here, or an entry with no row, reds.
 */
export const TEST_ENV_RESTORE_ADMISSIONS: Readonly<
	Record<string, EnvRestoreAdmission>
> = {
	"tests/clients/call-graph.test.ts": {
		mechanism: "teardown",
		reason:
			"most cases delete it after their own assertions and a few use a finally, so a throwing case leaks it",
	},
	"tests/clients/codebase-model.test.ts": {
		mechanism: "teardown",
		reason:
			"the delete runs at the end of each case body, not in the file's afterEach",
	},
	"tests/clients/debug-handles.test.ts": {
		mechanism: "teardown",
		reason:
			"the describe's afterEach restores a saved flag, but the write is in the module-level importFresh helper",
	},
	"tests/clients/debug-heap.test.ts": {
		mechanism: "teardown",
		reason:
			"the describe's afterEach restores a saved flag, but the write is in the module-level importFresh helper",
	},
	"tests/clients/dispatch/adopted-root-runners.test.ts": {
		mechanism: "teardown",
		reason:
			"prepareBrokenScript stubs PATH from module scope; the describe's afterEach unstubs for the tests that call it",
	},
	"tests/clients/dispatch/runners/terraform-kotlin-runners.test.ts": {
		mechanism: "finally",
		reason:
			"the vi.unstubAllEnvs sits in a different function's finally than the stub",
	},
	"tests/clients/dotnet-root-markers.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/effective-config.test.ts": {
		mechanism: "teardown",
		reason:
			"several finally blocks and case bodies restore the key; the flagged writes sit outside all of them",
	},
	"tests/clients/install-attempt-evidence.test.ts": {
		mechanism: "teardown",
		reason:
			"the key is restored through withEnv's closure; the flagged site is the helper call's own write",
	},
	"tests/clients/installer/archive-install.integration.test.ts": {
		mechanism: "module-pin",
		reason: "hoisted fixture pins set once for the archive fixture",
	},
	"tests/clients/installer/archive-tree-manifest-3400.test.ts": {
		mechanism: "teardown",
		reason: "JAVA_HOME is set per case and only some cases put it back",
	},
	"tests/clients/installer/install-lock.test.ts": {
		mechanism: "module-pin",
		reason:
			"vi.hoisted sets PI_LENS_HOME before the installer modules load, and no hook restores it",
	},
	"tests/clients/installer/managed-tool-refresh-strategies.test.ts": {
		mechanism: "teardown",
		reason:
			"the deletes run in a beforeEach, which resets the next case but does not undo the last one",
	},
	"tests/clients/installer/managed-tool-refresh.test.ts": {
		mechanism: "teardown",
		reason:
			"the deletes run in a beforeEach, which resets the next case but does not undo the last one",
	},
	"tests/clients/installer/version-drift.test.ts": {
		mechanism: "teardown",
		reason:
			"the key is restored through withEnv's closure; the flagged site is the helper call's own write",
	},
	"tests/clients/lens-config.test.ts": {
		mechanism: "teardown",
		reason:
			"the file's afterEach resets module state; no hook names the variable it set",
	},
	"tests/clients/lsp-covers-config.test.ts": {
		mechanism: "teardown",
		reason:
			"the restores sit at the end of case bodies, not in the file's afterEach",
	},
	"tests/clients/lsp/classic-repair-rearm.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/client-ceiling.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/client-registry-direct.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/idle-eviction-probe-driver.test.ts": {
		mechanism: "teardown",
		reason:
			"the beforeEach deletes it, which resets the next case but does not undo the last one",
	},
	"tests/clients/lsp/integration.test.ts": {
		mechanism: "module-pin",
		reason:
			"vi.hoisted sets the shutdown timeout before the imports evaluate, and no hook restores it",
	},
	"tests/clients/lsp/lsp-publish-trace-attribution.test.ts": {
		mechanism: "module-pin",
		reason:
			"PILENS_PUB_DEBUG is read once when clients/lsp/client.js loads, so the pin has to sit before the dynamic import and no per-case hook can put the flag back after the module captured it",
	},
	"tests/clients/lsp/managed-bin-fastpath.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/managed-fallback-after-trust-refusal-4515.test.ts": {
		mechanism: "module-pin",
		reason:
			"vi.hoisted sets PI_LENS_TEST_MODE before the imports evaluate, and no hook restores it",
	},
	"tests/clients/lsp/rename-notify-wedged.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/root-coalescing.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/runtime-install-discovery.test.ts": {
		mechanism: "teardown",
		reason:
			"the first describe's afterEach restores its saved copy; the second describe deletes GOPATH inside its own case",
	},
	"tests/clients/lsp/server-init-overrides.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/server-policy.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/service-notify-cpu-liveness.test.ts": {
		mechanism: "module-pin",
		reason:
			"vi.hoisted sets PI_LENS_TEST_MODE before the imports evaluate, and no hook restores it",
	},
	"tests/clients/lsp/service-notify-inflight-throttle-real-stream.test.ts": {
		mechanism: "teardown",
		reason:
			"runSweep writes it in a module-level helper; the afterEach resets module state only",
	},
	"tests/clients/lsp/shutdown-live-wedged-process.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/shutdown-wedged-connection.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/teardown-logging.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/typescript-classic-repair.integration.test.ts": {
		mechanism: "teardown",
		reason:
			"the afterAll restores at file end, so every case runs on the previous case's value",
	},
	"tests/clients/lsp/typescript-root.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/typos-server-init.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/lsp/touch-debounce-content-gate.test.ts": {
		mechanism: "module-pin",
		reason:
			"master's #4532 test pins the debounce before its dynamic imports in vi.hoisted; no hook restores the original value",
	},
	"tests/clients/lsp/workspace-diagnostics-per-server.test.ts": {
		mechanism: "teardown",
		reason: "one case restores in a finally; the rest set it in a case body",
	},
	"tests/clients/lsp/workspace-diagnostics-suppression.test.ts": {
		mechanism: "teardown",
		reason:
			"the beforeEach deletes it, which resets the next case but does not undo the last one",
	},
	"tests/clients/module-report-call-graph.test.ts": {
		mechanism: "teardown",
		reason:
			"the delete runs at the end of the case body, not in the file's afterEach",
	},
	"tests/clients/persist-worker-message-fault-injection.test.ts": {
		mechanism: "teardown",
		reason:
			"the data dir is deleted at the end of the body, the debounce is set to a literal, the sync pin is deleted in a beforeEach",
	},
	"tests/clients/project-snapshot-worker-result-stagepath.test.ts": {
		mechanism: "teardown",
		reason:
			"the beforeEach deletes it, which resets the next case but does not undo the last one",
	},
	"tests/clients/reverse-deps-cache.test.ts": {
		mechanism: "finally",
		reason:
			"the unstub is in a different function's finally, and a beforeEach delete only resets the next case",
	},
	"tests/clients/review-graph-persist-worker-stagepath.test.ts": {
		mechanism: "teardown",
		reason:
			'the afterEach sets the debounce variable to the literal "0", not the ambient value',
	},
	"tests/clients/review-graph-persist.test.ts": {
		mechanism: "teardown",
		reason:
			'the afterEach sets the debounce variable to the literal "0", not the ambient value',
	},
	"tests/clients/review-graph/checkpoint-resume.test.ts": {
		mechanism: "teardown",
		reason:
			'the afterEach sets the debounce variable to the literal "0", not the ambient value',
	},
	"tests/clients/review-graph/lsp-symbol-fallback.test.ts": {
		mechanism: "teardown",
		reason:
			'the afterEach sets the debounce variable to the literal "0", not the ambient value',
	},
	"tests/clients/review-graph/stage-sweep.test.ts": {
		mechanism: "teardown",
		reason:
			'the afterEach sets the debounce variable to the literal "0", not the ambient value',
	},
	"tests/clients/runtime-session-quick-mode-observability.test.ts": {
		mechanism: "teardown",
		reason:
			"it is set through a helper that returns the restore closure the case must call",
	},
	"tests/clients/runtime-session-scan-cache.test.ts": {
		mechanism: "teardown",
		reason:
			"it is set through a helper that returns the restore closure the case must call",
	},
	"tests/clients/runtime-session-snapshot-gate.test.ts": {
		mechanism: "teardown",
		reason:
			"the afterEach that restores both keys belongs to a nested describe, so outer-suite writes are not covered",
	},
	"tests/clients/runtime-session-warm-skip-notify.test.ts": {
		mechanism: "teardown",
		reason:
			"the pins are set through a helper that returns the restore closure the case must call",
	},
	"tests/clients/runtime-session-warm.test.ts": {
		mechanism: "teardown",
		reason:
			"setStartupMode writes it in a module-level helper and returns the restore closure the case must call",
	},
	"tests/clients/session-start-total-classification.test.ts": {
		mechanism: "teardown",
		reason:
			"it is set through a helper that returns the restore closure the case must call",
	},
	"tests/clients/test-utils.ts": {
		mechanism: "helper",
		reason:
			"pinTestHome returns the undo closure and its callers own the restore",
	},
	"tests/clients/tree-sitter-cache-stats-astgrep-coverage.test.ts": {
		mechanism: "teardown",
		reason: "set in a case body; the afterEach resets module state only",
	},
	"tests/clients/tree-sitter-logger.test.ts": {
		mechanism: "module-pin",
		reason: "set before the dynamic import and never restored",
	},
	"tests/clients/word-index-persist.test.ts": {
		mechanism: "teardown",
		reason:
			'the afterEach sets the debounce variable to the literal "0", not the ambient value',
	},
	"tests/index-integration.test.ts": {
		mechanism: "teardown",
		reason:
			"the restores sit at the end of each case body and in a few finallys; most cases have neither",
	},
	"tests/index-lsp-idle-reset.test.ts": {
		mechanism: "teardown",
		reason:
			"the subagent pins are restored in finallys and case bodies; the flagged writes are outside them",
	},
	"tests/index-process-bridge-rebind-real-factory.test.ts": {
		mechanism: "none",
		reason:
			"vi.stubEnv in a case body, and no unstubAllEnvs anywhere in the file",
	},
	"tests/scripts/test-history-rollup.test.ts": {
		mechanism: "none",
		reason:
			"vi.stubEnv for the job summary in a helper, and no unstubAllEnvs anywhere in the file",
	},
	"tests/support/fault-injection.test.ts": {
		mechanism: "teardown",
		reason:
			"the kit's starveBudget stubs it; the afterEach that unstubs belongs to the calling suite",
	},
	"tests/support/fault-injection.ts": {
		mechanism: "none",
		reason:
			"starveBudget leaves vi.unstubAllEnvs to its caller by contract, and the file has no hook",
	},
	"tests/support/git-fixture-env.test.ts": {
		mechanism: "teardown",
		reason:
			"the scrub-and-install helper mutates the env from a beforeEach loop",
	},
	"tests/support/git-fixture-env.ts": {
		mechanism: "none",
		reason:
			"installGitFixtureEnv mutates process.env by design and never restores it",
	},
	"tests/support/prewarm-tool-home.ts": {
		mechanism: "none",
		reason:
			"the prewarm helper sets the template variable and never restores it",
	},
	"tests/support/vitest-setup-console-channel.test.ts": {
		mechanism: "finally",
		reason: "the finally restores it in another function body than the write's",
	},
	"tests/support/vitest-setup.ts": {
		mechanism: "module-pin",
		reason:
			"global setup pins the machine-global variables once for the process and deletes the whole subagent vocabulary at load, through the key list `clients/subagent-mode.ts` exports, before any case: the jiti cache switches (#4673) and the absence of an inherited marker both have to hold for the whole worker, so restoring either would re-enable the write between cases (a Gentle Shell lane inherits GENTLE_PI_AGENTS_CHILD=1)",
	},
	"tests/support/with-env.test.ts": {
		mechanism: "teardown",
		reason:
			"KEY2 is set through withEnv and restored by the afterEach calling that closure",
	},
	"tests/support/with-env.ts": {
		mechanism: "helper",
		reason:
			"withEnv writes each override and returns the restore closure its caller owns",
	},
	"tests/tools/lens-diagnostics.test.ts": {
		mechanism: "teardown",
		reason:
			"set per case and the afterEach clears derived state, not the variable",
	},
	"tests/tools/lsp-diagnostics-2776.test.ts": {
		mechanism: "module-pin",
		reason:
			"module-scope pins applied with Object.assign before the dynamic import",
	},
	"tests/tools/lsp-diagnostics-root-fallback-3750.test.ts": {
		mechanism: "teardown",
		reason:
			"the nested afterAll unstubs, a chain that does not cover the flagged writes",
	},
};
