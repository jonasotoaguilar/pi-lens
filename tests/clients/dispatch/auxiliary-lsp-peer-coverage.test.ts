/**
 * Subagent light mode's auxiliary skip, conditioned on real peer coverage
 * (odd/tasks/subagent-memory, #713's premise corrected).
 *
 * #713 returned `[]` from `enabledAuxiliaryLspServerIds()` for ANY detected
 * subagent session, on the premise that the parent session runs those
 * auxiliaries on the SAME cwd. Two delegated launches break that premise:
 * Gentle Shell starts a child `pi` with cwd = the `workspace_root` tool
 * argument (another worktree of the same clone) or the `repository_root`
 * argument (an independent repository), and no environment variable carries
 * location identity — so the child ended with no opengrep/ast-grep/typos/
 * zizmor coverage of a tree no peer fleet serves.
 *
 * The skip now requires a live peer instance holding the child's OWN project
 * root; every case here drives the real registry read (a fabricated
 * `instances.json` under a pinned `PI_LENS_HOME`) or the pure entry list, and
 * asserts through the public gate.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	_resetSubagentAuxiliaryPeerCoverageForTests,
	enabledAuxiliaryLspServerIds,
	refreshSubagentAuxiliaryPeerCoverage,
	subagentAuxiliaryFleetDeferredToPeer,
} from "../../../clients/dispatch/auxiliary-lsp.js";
import {
	type InstanceEntry,
	_resetInstanceRegistryEnabledForTests,
} from "../../../clients/instance-registry.js";
import {
	_setRecentPhasesForTest,
	getRecentLoggedPhases,
} from "../../../clients/latency-logger.js";
import { _resetSubagentModeForTests } from "../../../clients/subagent-mode.js";
import { removeTempDirSync } from "../test-utils.js";
import { withEnv } from "../../support/with-env.js";

/** The child session's own project root — the one `registerInstance` records. */
const OWN_ROOT = path.join(os.tmpdir(), "pi-lens-peer-coverage-own");
const OTHER_ROOT = path.join(os.tmpdir(), "pi-lens-peer-coverage-other");
const PARENT_ROOT = path.dirname(OWN_ROOT);

/** A fixed clock for one case: every fabricated entry's heartbeat is fresh
 *  against it, and the pure-entry cases pass it as the probe's `now`. The
 *  registry-file cases let the probe read the real clock, which lands within
 *  the same heartbeat window. */
const NOW = Date.now();

const PEER_COVERAGE_PHASE = "subagent_auxiliary_peer_coverage";

/** This process's parent: a real live pid that is never `process.pid` (the
 *  comparator excludes the caller's own entry by definition). */
const LIVE_PEER_PID = process.ppid;

function peerEntry(over: Partial<InstanceEntry> = {}): InstanceEntry {
	return {
		pid: LIVE_PEER_PID,
		startedAt: new Date(NOW - 60_000).toISOString(),
		projectRoot: OWN_ROOT,
		projectRoots: [OWN_ROOT],
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date(NOW).toISOString(),
		...over,
	};
}

function coverageRows() {
	return getRecentLoggedPhases().filter(
		(row) => row.phase === PEER_COVERAGE_PHASE,
	);
}

describe("subagent auxiliary fleet is skipped only under real peer coverage", () => {
	let registryHome: string;
	let previousHome: string | undefined;

	beforeEach(() => {
		registryHome = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-peer-coverage-home-"),
		);
		previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = registryHome;
		_resetInstanceRegistryEnabledForTests();
		_resetSubagentModeForTests();
		_resetSubagentAuxiliaryPeerCoverageForTests();
		// The phase ring is process-wide and survives a case; this file's only
		// subject in it is its own coverage row, so each case starts from empty.
		_setRecentPhasesForTest([]);
	});

	afterEach(() => {
		_resetSubagentAuxiliaryPeerCoverageForTests();
		_resetSubagentModeForTests();
		_resetInstanceRegistryEnabledForTests();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		removeTempDirSync(registryHome);
	});

	function writeRegistry(instances: InstanceEntry[]): void {
		fs.writeFileSync(
			path.join(registryHome, "instances.json"),
			JSON.stringify({ instances }),
			"utf8",
		);
	}

	it("skips the fleet when a live peer serves this session's own root", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			writeRegistry([peerEntry()]);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			expect(deferred).toBe(true);
			expect(subagentAuxiliaryFleetDeferredToPeer()).toBe(true);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([]);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("keeps the fleet when no peer covers the root", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			writeRegistry([]);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			expect(deferred).toBe(false);
			expect(subagentAuxiliaryFleetDeferredToPeer()).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([
				"opengrep",
				"ast-grep",
				"zizmor",
				"typos",
			]);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("keeps the fleet when the only peer is registered on a different root", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			writeRegistry([
				peerEntry({ projectRoot: OTHER_ROOT, projectRoots: [OTHER_ROOT] }),
			]);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			expect(deferred).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("keeps the fleet when the peer sits at a containing root, not the same one", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			// `"exact"` is the mode the skip is written for: a parent session
			// serving the directory ABOVE the child's root does not run the
			// auxiliary fleet over the child's tree.
			writeRegistry([
				peerEntry({ projectRoot: PARENT_ROOT, projectRoots: [PARENT_ROOT] }),
			]);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			expect(deferred).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("keeps the fleet when a same-root entry's pid is dead", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
				now: NOW,
				isPidAlive: () => false,
			});

			expect(deferred).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("keeps the fleet when the registry cannot be read", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			fs.writeFileSync(
				path.join(registryHome, "instances.json"),
				'{ "instances": [',
				"utf8",
			);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			// The registry's own read already degrades a torn file to "no known
			// peer"; an unanswered coverage question must never read as covered.
			expect(deferred).toBe(false);
			expect(subagentAuxiliaryFleetDeferredToPeer()).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("does not count a peer whose own root is the registration guess", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			// `rootSource: "lsp-fallback"` marks root #0 as `process.cwd()`
			// synthesized before any real registration (#2130) — a guess, not
			// evidence that a fleet works on this tree.
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry({ rootSource: "lsp-fallback" })],
				now: NOW,
				isPidAlive: () => true,
			});

			expect(deferred).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("counts a peer whose real SECOND root is this session's root", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [
					peerEntry({
						projectRoot: OTHER_ROOT,
						projectRoots: [OTHER_ROOT, OWN_ROOT],
					}),
				],
				now: NOW,
				isPidAlive: () => true,
			});

			expect(deferred).toBe(true);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([]);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("PI_LENS_SUBAGENT_FULL=1 keeps the fleet even under a covering peer", async () => {
		const restore = withEnv({
			GENTLE_PI_AGENTS_CHILD: "1",
			PI_LENS_SUBAGENT_FULL: "1",
		});
		_resetSubagentModeForTests();
		try {
			writeRegistry([peerEntry()]);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			expect(deferred).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([
				"opengrep",
				"ast-grep",
				"zizmor",
				"typos",
			]);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("a primary session reads no coverage decision and keeps the fleet", async () => {
		const restore = withEnv({
			PI_SUBAGENT_CHILD: undefined,
			GENTLE_PI_AGENTS_CHILD: undefined,
		});
		_resetSubagentModeForTests();
		try {
			// A covering peer IS registered: only "this is not a subagent session"
			// can explain a fleet that still runs, so the case proves the probe
			// never consults the registry for a primary session.
			writeRegistry([peerEntry()]);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			expect(deferred).toBe(false);
			expect(subagentAuxiliaryFleetDeferredToPeer()).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([
				"opengrep",
				"ast-grep",
				"zizmor",
				"typos",
			]);
			expect(coverageRows()).toHaveLength(0);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("a superseded session publishes no decision", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
				now: NOW,
				isPidAlive: () => true,
				isCurrent: () => false,
			});

			// The answer arrived after its session was replaced: it must not decide
			// the fleet of whichever session is current now (shape 22).
			expect(deferred).toBe(false);
			expect(subagentAuxiliaryFleetDeferredToPeer()).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("records the self-served cost once per session", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			writeRegistry([]);
			await refreshSubagentAuxiliaryPeerCoverage({ root: OWN_ROOT });

			const rows = coverageRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({ peerCovered: false });

			// A second refresh for the same root (a re-fired session start) adds no
			// second row: the record is bounded by the session, not by the caller.
			await refreshSubagentAuxiliaryPeerCoverage({ root: OWN_ROOT });
			expect(coverageRows()).toHaveLength(1);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});
});
