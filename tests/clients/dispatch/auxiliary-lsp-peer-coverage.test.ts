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
 * The skip now requires TWO premises, and re-checks both when it is read:
 *
 *  1. a live peer instance holds the child's OWN project root, and
 *  2. warm attach is attached to that peer, so the child can actually obtain
 *     that fleet's answers for that root. Without attachment the child runs its
 *     own fleet: a registered peer it cannot read from covers nothing.
 *
 * Every case here drives the real registry read (a fabricated `instances.json`
 * under a pinned `PI_LENS_HOME`) or the pure entry list, warm attach's own
 * attached-state seam, and the public gate. The gate re-validates the premise
 * on every read, so a decision that stops being true re-arms the session to
 * ENABLED (one bounded record) and never back.
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
import {
	_resetWarmAttachForTests,
	_setWarmAttachForTests,
} from "../../../clients/warm-attach.js";
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
const REARM_PHASE = "subagent_auxiliary_peer_coverage_rearmed";

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

function rearmRows() {
	return getRecentLoggedPhases().filter((row) => row.phase === REARM_PHASE);
}

/** A pid this machine answers ESRCH for, so the read-time premise check runs the
 *  production liveness probe rather than an injected one. */
function findDeadPid(): number {
	for (let candidate = 999_983; candidate > 1_000; candidate -= 7_919) {
		try {
			process.kill(candidate, 0);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ESRCH") return candidate;
		}
	}
	throw new Error("could not find a definitively dead pid");
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
		_resetWarmAttachForTests();
		// The phase ring is process-wide and survives a case; this file's only
		// subject in it is its own coverage row, so each case starts from empty.
		_setRecentPhasesForTest([]);
	});

	afterEach(() => {
		_resetSubagentAuxiliaryPeerCoverageForTests();
		_resetWarmAttachForTests();
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

	it("skips the fleet when a live peer serves this session's own root and warm attach reads from it", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			writeRegistry([peerEntry()]);
			_setWarmAttachForTests(OWN_ROOT, LIVE_PEER_PID);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
			});

			expect(deferred).toBe(true);
			expect(subagentAuxiliaryFleetDeferredToPeer()).toBe(true);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([]);
			// A read that still holds its premises re-arms nothing.
			expect(rearmRows()).toHaveLength(0);
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
			_setWarmAttachForTests(OWN_ROOT, LIVE_PEER_PID);
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

	it("keeps the fleet when a live peer serves the root but nothing is attached", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			// Premise 1 holds and premise 2 does not: a registered peer whose
			// answers this session cannot obtain covers nothing, so the fleet runs
			// here instead of scanning nothing.
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
				now: NOW,
				isPidAlive: () => true,
			});

			expect(deferred).toBe(false);
			expect(subagentAuxiliaryFleetDeferredToPeer()).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
			expect(coverageRows()[0]?.metadata).toMatchObject({
				peerCovered: false,
				attached: false,
			});
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("keeps the fleet when warm attach is attached to a different root", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			// This process reads another tree's fleet: the same-root peer exists on
			// paper, and none of its answers reaches this root.
			_setWarmAttachForTests(OTHER_ROOT, LIVE_PEER_PID);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
				now: NOW,
				isPidAlive: () => true,
			});

			expect(deferred).toBe(false);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
			expect(coverageRows()[0]?.metadata).toMatchObject({
				attachedRootMatches: false,
			});
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("keeps the fleet when the attached incumbent is not the peer on this root", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			// Attached to a live incumbent for the right root, but that incumbent is
			// not the instance registered as this root's peer: nothing proves the
			// fleet answering this session scans this tree either.
			_setWarmAttachForTests(OWN_ROOT, process.pid);
			const deferred = await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
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

	it("re-enables the fleet when the attachment is gone after the decision", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_resetWarmAttachForTests();
			_setWarmAttachForTests(OWN_ROOT, LIVE_PEER_PID);
			await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
				now: NOW,
				isPidAlive: () => true,
			});
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([]);

			// The incumbent goes away (a takeover, or its own shutdown): the premise
			// the decision rested on is gone, so the session flips to ENABLED.
			_resetWarmAttachForTests();
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
			// Repeated reads re-arm nothing further: one bounded transition record.
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
			const rows = rearmRows();
			expect(rows).toHaveLength(1);
			expect(rows[0]?.metadata).toMatchObject({ reason: "detached" });
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("re-enables the fleet when the attached incumbent is no longer alive", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			const deadPid = findDeadPid();
			_setWarmAttachForTests(OWN_ROOT, deadPid);
			// The decision-time liveness answer is injected ALIVE, which is what lets
			// a covered decision exist at all; the read-time check is the
			// production one, and it finds the incumbent gone.
			await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry({ pid: deadPid })],
				now: NOW,
				isPidAlive: () => true,
			});
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
			expect(rearmRows()[0]?.metadata).toMatchObject({
				reason: "incumbent-exited",
			});
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("does not flip back to the skip once it has re-armed", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(OWN_ROOT, LIVE_PEER_PID);
			await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
				now: NOW,
				isPidAlive: () => true,
			});
			_resetWarmAttachForTests();
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);

			// The attachment comes back, and the session still runs its own fleet:
			// the transition is one-way, so the same session cannot flap back to a
			// silent skip behind the premise that already failed once.
			_setWarmAttachForTests(OWN_ROOT, LIVE_PEER_PID);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
			expect(rearmRows()).toHaveLength(1);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("a decision for one root does not answer where this process attached next", async () => {
		const restore = withEnv({ PI_SUBAGENT_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(OWN_ROOT, LIVE_PEER_PID);
			await refreshSubagentAuxiliaryPeerCoverage({
				root: OWN_ROOT,
				entries: [peerEntry()],
				now: NOW,
				isPidAlive: () => true,
			});
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toEqual([]);

			// The process now holds a second root. Its answer is unknown, not the
			// first root's answer: a cached decision keyed on nothing would have kept
			// skipping the fleet on a tree no attached incumbent serves.
			_setWarmAttachForTests(OTHER_ROOT, LIVE_PEER_PID);
			expect(enabledAuxiliaryLspServerIds(() => undefined)).toContain(
				"opengrep",
			);
			expect(rearmRows()[0]?.metadata).toMatchObject({
				reason: "root-mismatch",
			});
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
			_setWarmAttachForTests(OWN_ROOT, LIVE_PEER_PID);
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
			expect(rows[0]?.metadata).toMatchObject({
				peerCovered: false,
				attached: false,
			});

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
