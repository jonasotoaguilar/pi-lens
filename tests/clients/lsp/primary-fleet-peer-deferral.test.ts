/**
 * T1 (G1) of odd/tasks/lsp-fleet-memory — a subagent whose own project root a
 * live peer already serves stops spawning its own PRIMARY language server, not
 * only its auxiliary scanners (`tests/clients/dispatch/auxiliary-lsp-peer-coverage.test.ts`
 * pins that half).
 *
 * The gate is the auxiliary gate's premise, read through the same seam
 * (`clients/dispatch/auxiliary-lsp.ts`). The failure it must not introduce is
 * the one the ODD calls the trap: a child that skips its own fleet while
 * holding no usable borrowed attachment gets NOTHING. So every premise doubt —
 * no attachment, another root, an incumbent that published no endpoint, a peer
 * that disappeared mid-session — re-arms toward ENABLED, and a primary session
 * never defers on a subagent's claim.
 *
 * The subject is `LSPService.touchFile`, the door every diagnostics/sync touch
 * uses. The only double is the launched binary (`spawn`), as in
 * `tests/clients/lsp/projectless-spawn-decline-4806.test.ts`: a spawn call is
 * the evidence that the fleet ran here, and its absence is the evidence that a
 * covered child stopped paying for a server a peer already runs.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	_resetSubagentAuxiliaryPeerCoverageForTests,
	refreshSubagentAuxiliaryPeerCoverage,
} from "../../../clients/dispatch/auxiliary-lsp.js";
import {
	type InstanceEntry,
	_resetInstanceRegistryEnabledForTests,
} from "../../../clients/instance-registry.js";
import {
	_setRecentPhasesForTest,
	getRecentLoggedPhases,
} from "../../../clients/latency-logger.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { type LSPServerInfo } from "../../../clients/lsp/server.js";
import {
	registerSessionRoot,
	resetSessionRootsForTests,
} from "../../../clients/lsp/session-roots.js";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import {
	resetProjectTrust,
	setProjectTrustState,
} from "../../../clients/project-trust.js";
import { _resetSubagentModeForTests } from "../../../clients/subagent-mode.js";
import {
	_resetWarmAttachForTests,
	_setWarmAttachForTests,
	tryWarmAttachedDiagnostics,
} from "../../../clients/warm-attach.js";
import { removeTempDirSync } from "../test-utils.js";
import { withEnv } from "../../support/with-env.js";

/** This process's parent: a real live pid, never `process.pid` (the comparator
 *  excludes the caller's own entry by definition). */
const PEER_PID = process.ppid;
const NOW = Date.now();
const REARM_PHASE = "subagent_auxiliary_peer_coverage_rearmed";
const DEFERRAL_KIND = "lsp-primary-fleet-deferred-to-peer";

function peerEntry(
	root: string,
	over: Partial<InstanceEntry> = {},
): InstanceEntry {
	return {
		pid: PEER_PID,
		startedAt: new Date(NOW - 60_000).toISOString(),
		projectRoot: root,
		projectRoots: [root],
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date(NOW).toISOString(),
		...over,
	};
}

function rearmRows() {
	return getRecentLoggedPhases().filter((row) => row.phase === REARM_PHASE);
}

function deferralRows() {
	return (
		getDegradationSummary().find((group) => group.kind === DEFERRAL_KIND)
			?.latestReasons ?? []
	);
}

function selectedRows() {
	return getRecentLoggedPhases().filter(
		(row) => row.phase === "lsp_client_selected",
	);
}

describe("a covered subagent runs no primary language server of its own", () => {
	let tmpDir: string;
	let registryHome: string;
	let previousHome: string | undefined;
	let spawn: ReturnType<typeof vi.fn>;
	/** The child's own project root — the one its peer must hold EXACTLY. */
	let ownRoot: string;
	let otherRoot: string;
	/** The peer's declared root for a different-root case: the directory ABOVE the
	 *  child's own root still covers a different tree, exactly as `"exact"` means. */
	let parentRoot: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-primary-fleet-"));
		registryHome = path.join(tmpDir, "home");
		fs.mkdirSync(registryHome, { recursive: true });
		previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = registryHome;
		// Both roots live under this case's own directory, so `parentRoot` is a
		// real directory above the child's and no two runs share a path.
		ownRoot = path.join(tmpDir, "own");
		otherRoot = path.join(tmpDir, "other");
		parentRoot = tmpDir;
		fs.mkdirSync(ownRoot, { recursive: true });
		fs.mkdirSync(otherRoot, { recursive: true });
		registerSessionRoot(ownRoot);
		setProjectTrustState("trusted");
		resetDegradationLedger();
		_resetInstanceRegistryEnabledForTests();
		_resetSubagentModeForTests();
		_resetSubagentAuxiliaryPeerCoverageForTests();
		_resetWarmAttachForTests();
		_setRecentPhasesForTest([]);
		spawn = vi.fn(async () => undefined);
		// The production launch path with only the binary stubbed: a call is the
		// evidence the fleet ran here, and it starts no process.
		const server: LSPServerInfo = {
			id: "typescript",
			name: "TypeScript",
			extensions: [".ts"],
			idleEviction: "resident",
			root: async () => ownRoot,
			spawn,
		} as unknown as LSPServerInfo;
		_setServersForFileForTests(() => [server]);
	});

	afterEach(() => {
		_setServersForFileForTests(undefined);
		resetSessionRootsForTests();
		resetProjectTrust();
		resetDegradationLedger();
		_resetSubagentAuxiliaryPeerCoverageForTests();
		_resetWarmAttachForTests();
		_resetSubagentModeForTests();
		_resetInstanceRegistryEnabledForTests();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		removeTempDirSync(tmpDir);
	});

	/** Prime the session as a subagent whose peer holds `root` AND whose warm
	 *  attach reads from that peer, which is what `covered` means. Returns the
	 *  probe's answer so a case fails on the premise, not on the gate. */
	async function coverOwnRoot(root = ownRoot): Promise<boolean> {
		return refreshSubagentAuxiliaryPeerCoverage({
			root,
			entries: [peerEntry(root)],
			now: NOW,
			isPidAlive: () => true,
		});
	}

	async function touch(
		filePath: string,
		clientScope: "primary" | "all",
		extra: { peerAnswerUnavailable?: boolean } = {},
	) {
		const service = new LSPService();
		return service.touchFile(filePath, "const value = 1;\n", {
			diagnostics: "none",
			clientScope,
			source: clientScope === "all" ? "lens_diagnostics" : "lsp_sync",
			...extra,
		});
	}

	it("does not spawn the primary server for a covered child's diagnostics touch", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(ownRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
			expect(await coverOwnRoot()).toBe(true);
			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			const touched = await touch(file, "primary");

			// No local answer, and — the observable this case exists for — no
			// primary server process and no `lsp_client_selected` spawn record.
			expect(touched).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
			expect(selectedRows()).toHaveLength(0);
			// The skip is a first-class record naming the root whose peer serves it.
			expect(deferralRows()).toHaveLength(1);
			expect(deferralRows()[0]?.subject).toBe(normalizeMapKey(ownRoot));
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("runs its own primary server when the live peer holds a different root", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(otherRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
			// A peer on the child's parent directory is still a DIFFERENT root.
			expect(
				await refreshSubagentAuxiliaryPeerCoverage({
					root: ownRoot,
					entries: [peerEntry(parentRoot)],
					now: NOW,
					isPidAlive: () => true,
				}),
			).toBe(false);
			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			await touch(file, "primary");

			expect(spawn).toHaveBeenCalledTimes(1);
			expect(deferralRows()).toHaveLength(0);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("re-arms toward running its own fleet, with one bounded record, when the peer disappears mid-session", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(ownRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
			expect(await coverOwnRoot()).toBe(true);
			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");
			expect(await touch(file, "primary")).toBeUndefined();
			expect(spawn).not.toHaveBeenCalled();
			expect(rearmRows()).toHaveLength(0);

			// The incumbent takes over its own answers (`promoteToLocal`), so this
			// session no longer reads any peer's fleet. The phase ring is the
			// attribution breadcrumb `getRecentLoggedPhases` reads (5 entries), not
			// a trace: each assertion starts it empty.
			_resetWarmAttachForTests();
			_setRecentPhasesForTest([]);

			await touch(file, "primary");
			expect(spawn).toHaveBeenCalledTimes(1);
			expect(rearmRows()).toHaveLength(1);
			expect(rearmRows()[0]?.metadata).toMatchObject({ reason: "detached" });

			// One bounded record: a later read cannot add another, and the session
			// stays enabled rather than flipping back.
			_setRecentPhasesForTest([]);
			await touch(file, "primary");
			expect(spawn).toHaveBeenCalledTimes(2);
			expect(rearmRows()).toHaveLength(0);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("does not count an incumbent that published no endpoint as coverage", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			// An attachment naming a live peer on the right root, but the peer
			// published no bound endpoint: nothing proves anything listens there, so
			// the premise is never granted and the child runs its own fleet instead
			// of borrowing nothing.
			_setWarmAttachForTests(ownRoot, PEER_PID);
			expect(await coverOwnRoot()).toBe(false);
			expect(
				getRecentLoggedPhases().find(
					(row) => row.phase === "subagent_auxiliary_peer_coverage",
				)?.metadata,
			).toMatchObject({ peerCovered: false, attachedEndpointPublished: false });

			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");
			await touch(file, "primary");

			expect(spawn).toHaveBeenCalledTimes(1);
			expect(deferralRows()).toHaveLength(0);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("still answers an explicit all-server request from its own fleet while covered", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(ownRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
			expect(await coverOwnRoot()).toBe(true);
			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			// An explicit all-server check is a real question about this tree, and
			// a covered child must not answer it with the fleet it skipped.
			await touch(file, "all");

			expect(spawn).toHaveBeenCalledTimes(1);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("still answers an explicit single-file query from its own fleet while covered", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(ownRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
			expect(await coverOwnRoot()).toBe(true);
			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			// `lens_diagnostics source=lsp` on one file sets `explicitQuery`: the
			// operator asked THIS process, and its answer must come from a fleet that
			// ran here.
			const service = new LSPService();
			await service.touchFile(file, "const value = 1;\n", {
				diagnostics: "document",
				collectDiagnostics: true,
				clientScope: "primary",
				explicitQuery: true,
				source: "lsp_diagnostics",
			});

			expect(spawn).toHaveBeenCalledTimes(1);
			expect(deferralRows()).toHaveLength(0);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("runs its own primary server when the peer's answer for these bytes did not arrive", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(ownRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
			expect(await coverOwnRoot()).toBe(true);
			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			// The caller tried the peer for THESE bytes and got no usable answer
			// (a wedged request, its own timeout, a schema refusal, an IPC error).
			// Coverage of the root is not coverage of this file: the touch is
			// answered locally or not at all, and nothing may be skipped on the
			// strength of a root another process owns.
			await touch(file, "primary", { peerAnswerUnavailable: true });

			expect(spawn).toHaveBeenCalledTimes(1);
			expect(deferralRows()).toHaveLength(0);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("re-arms to its own fleet when the live request to the peer fails", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			fs.writeFileSync(
				path.join(registryHome, "instances.json"),
				JSON.stringify({ instances: [peerEntry(ownRoot)] }),
			);
			// The peer's entry proves a listener; the endpoint it published has
			// none (a peer that exited between registration and this request).
			_setWarmAttachForTests(
				ownRoot,
				PEER_PID,
				path.join(tmpDir, "gone", "pi-lens-peer.sock"),
			);
			expect(await coverOwnRoot()).toBe(true);
			const file = path.join(ownRoot, "app.ts");
			fs.writeFileSync(file, "const value = 1;\n");

			const attached = await tryWarmAttachedDiagnostics(file, "x", 200);

			// The warm route failed for these bytes, which promotes this session to
			// local (`promoteToLocal`) — so the fallback touch below is not covered
			// any more and must run a real server.
			expect(attached?.available).toBe(false);
			await touch(file, "primary");
			expect(spawn).toHaveBeenCalledTimes(1);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});

	it("never defers a primary session to a peer's claim", async () => {
		// A PRIMARY session (no subagent vocabulary) that is attached and whose
		// root a peer serves still runs its own fleet: the primary owns it.
		_setWarmAttachForTests(ownRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
		expect(await coverOwnRoot()).toBe(false);
		const file = path.join(ownRoot, "app.ts");
		fs.writeFileSync(file, "const value = 1;\n");

		await touch(file, "primary");

		expect(spawn).toHaveBeenCalledTimes(1);
		expect(deferralRows()).toHaveLength(0);
	});
});
