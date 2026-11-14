/**
 * T3 (G3) of odd/tasks/lsp-fleet-memory — the cross-process fleet budget
 * (`clients/lsp-budget.ts`) admits the PRIMARY language server, not only the
 * auxiliary fleet.
 *
 * The subject is the spawn decision, so the observables are the ones a
 * degraded session actually shows: the server's `spawn` (the process that must
 * NOT start), and the ledger row that names the root and the ceiling so the
 * missing language server is explicable later. A refused spawn is a
 * DEGRADATION: nothing is closed, killed or stolen, and the session's own live
 * servers keep answering (`tests/clients/lsp/client-registry-direct.test.ts`
 * drives that half directly, where a live client exists to keep).
 *
 * The instance registry is the real one on disk (`PI_LENS_HOME`), so a verdict
 * is measured from exactly what another `pi` session would have written. Only
 * the launched binary is doubled (`spawn`), as in
 * `tests/clients/lsp/primary-fleet-peer-deferral.test.ts`.
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
	_resetLspBudgetDecisionForTests,
	checkCrossProcessLspBudget,
} from "../../../clients/lsp-budget.js";
import { _setServersForFileForTests } from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import type { LSPServerInfo } from "../../../clients/lsp/server.js";
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
} from "../../../clients/warm-attach.js";
import { withEnv } from "../../support/with-env.js";
import { removeTempDirSync } from "../test-utils.js";

process.env.PI_LENS_TEST_MODE = "1";

/** This process's parent: a real live pid, never `process.pid` (the comparator
 *  excludes the caller's own entry by definition). */
const PEER_PID = process.ppid;
const NOW = Date.now();
const REFUSAL_KIND = "lsp-primary-spawn-refused-by-budget";
const PEER_DEFERRAL_KIND = "lsp-primary-fleet-deferred-to-peer";
/** Small enough that two children put the root at its ceiling. */
const ROOT_CEILING = 2;

function refusalRows() {
	return (
		getDegradationSummary().find((group) => group.kind === REFUSAL_KIND)
			?.latestReasons ?? []
	);
}

function peerDeferralRows() {
	return (
		getDegradationSummary().find((group) => group.kind === PEER_DEFERRAL_KIND)
			?.latestReasons ?? []
	);
}

function peerEntry(root: string): InstanceEntry {
	return {
		pid: PEER_PID,
		startedAt: new Date(NOW - 60_000).toISOString(),
		projectRoot: root,
		projectRoots: [root],
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date(NOW).toISOString(),
	};
}

describe("the fleet budget admits the primary language server", () => {
	let tmpDir: string;
	let registryHome: string;
	let ownRoot: string;
	/** Another session's root: on the same machine, never this session's share. */
	let otherRoot: string;
	let previousHome: string | undefined;
	let previousRootCeiling: string | undefined;
	let previousChild: string | undefined;
	/** One spawn double per primary server, so a case can say WHICH server ran. */
	let spawns: Record<string, ReturnType<typeof vi.fn>>;

	/** Write this process's own registry entry with `children` live LSP
	 *  children charged to its root — the file every other session reads. */
	function ownEntry(children: number): InstanceEntry {
		return {
			pid: process.pid,
			startedAt: new Date(NOW - 60_000).toISOString(),
			projectRoot: ownRoot,
			projectRoots: [ownRoot],
			lspChildren: Array.from({ length: children }, (_, index) => ({
				pid: 1000 + index,
				serverId: "typescript",
				command: "typescript-language-server",
				spawnedAt: new Date(NOW).toISOString(),
			})),
			lspChildCount: children,
			rssBytes: 0,
			heartbeatAt: new Date(NOW).toISOString(),
		};
	}

	/** Another live session on a DIFFERENT root: its children never charge this
	 *  session's root, but they do charge the machine. `process.ppid` is really
	 *  alive, so the real liveness predicate keeps it. */
	function foreignEntry(children: number): InstanceEntry {
		return {
			...ownEntry(children),
			pid: PEER_PID,
			projectRoot: otherRoot,
			projectRoots: [otherRoot],
		};
	}

	function writeRegistryWith(instances: InstanceEntry[]): void {
		fs.mkdirSync(registryHome, { recursive: true });
		fs.writeFileSync(
			path.join(registryHome, "instances.json"),
			JSON.stringify({ instances }),
			"utf8",
		);
	}

	function writeRegistry(children: number): void {
		writeRegistryWith([ownEntry(children)]);
	}

	/** A primary server over one extension, with its binary doubled. */
	function primary(serverId: string, extension: string): LSPServerInfo {
		const spawn = vi.fn(async () => undefined);
		spawns[serverId] = spawn;
		return {
			id: serverId,
			name: serverId,
			extensions: [extension],
			idleEviction: "resident",
			root: async () => ownRoot,
			spawn,
		} as unknown as LSPServerInfo;
	}

	let service: LSPService;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-primary-budget-"));
		registryHome = path.join(tmpDir, "home");
		fs.mkdirSync(registryHome, { recursive: true });
		previousHome = process.env.PI_LENS_HOME;
		previousRootCeiling = process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING;
		previousChild = process.env.GENTLE_PI_AGENTS_CHILD;
		process.env.PI_LENS_HOME = registryHome;
		process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING = String(ROOT_CEILING);
		delete process.env.GENTLE_PI_AGENTS_CHILD;
		ownRoot = path.join(tmpDir, "own");
		fs.mkdirSync(ownRoot, { recursive: true });
		otherRoot = path.join(tmpDir, "other");
		fs.mkdirSync(otherRoot, { recursive: true });
		registerSessionRoot(ownRoot);
		setProjectTrustState("trusted");
		resetDegradationLedger();
		_resetLspBudgetDecisionForTests();
		_resetInstanceRegistryEnabledForTests();
		_resetSubagentModeForTests();
		_resetSubagentAuxiliaryPeerCoverageForTests();
		_resetWarmAttachForTests();
		spawns = {};
		const ts = primary("typescript", ".ts");
		const py = primary("python", ".py");
		const go = primary("gopls", ".go");
		_setServersForFileForTests((filePath) =>
			filePath.endsWith(".ts") ? [ts] : filePath.endsWith(".py") ? [py] : [go],
		);
		service = new LSPService();
	});

	afterEach(async () => {
		await service.shutdown();
		_setServersForFileForTests(undefined);
		resetSessionRootsForTests();
		resetProjectTrust();
		resetDegradationLedger();
		_resetLspBudgetDecisionForTests();
		_resetInstanceRegistryEnabledForTests();
		_resetSubagentModeForTests();
		_resetSubagentAuxiliaryPeerCoverageForTests();
		_resetWarmAttachForTests();
		if (previousHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = previousHome;
		if (previousRootCeiling === undefined) {
			delete process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING;
		} else {
			process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING = previousRootCeiling;
		}
		if (previousChild === undefined) delete process.env.GENTLE_PI_AGENTS_CHILD;
		else process.env.GENTLE_PI_AGENTS_CHILD = previousChild;
		removeTempDirSync(tmpDir);
	});

	async function touch(name: string): Promise<void> {
		const file = path.join(ownRoot, name);
		fs.writeFileSync(file, "const value = 1;\n");
		await service.touchFile(file, "const value = 1;\n", {
			diagnostics: "none",
			clientScope: "primary",
			source: "lsp_sync",
		});
	}

	it("starts no primary server for a root already over its budget, and names the root and the ceiling", async () => {
		writeRegistry(ROOT_CEILING);
		await checkCrossProcessLspBudget();

		await touch("app.ts");

		// The observable this case exists for: no language-server process.
		expect(spawns.typescript).not.toHaveBeenCalled();
		// …and the one bounded record that explains it, naming the charged root
		// and the ceiling that refused the spawn.
		expect(refusalRows()).toHaveLength(1);
		const row = refusalRows()[0];
		expect(row?.subject).toBe(normalizeMapKey(ownRoot));
		expect(row?.reason).toContain(normalizeMapKey(ownRoot));
		expect(row?.reason).toContain(`ceiling of ${ROOT_CEILING}`);
	});

	it("starts the primary server for a root inside its budget", async () => {
		writeRegistry(ROOT_CEILING - 1);
		await checkCrossProcessLspBudget();

		await touch("app.ts");

		expect(spawns.typescript).toHaveBeenCalledTimes(1);
		expect(refusalRows()).toHaveLength(0);
	});

	it("refuses on the MACHINE stop alone, when the session's own root is inside its share", async () => {
		// "or the machine" is a stop, not a share: the run-wide ceiling exists for a
		// genuinely runaway fleet, and a root that is inside its own budget still
		// starts no new primary once the machine is at its ceiling. The row names
		// the MACHINE ceiling and the machine basis, not the root's.
		process.env.PI_LENS_LSP_BUDGET_CEILING = "1";
		try {
			// This session's root runs nothing (0 < its root ceiling); the machine is
			// at its stop because another live session holds one server.
			writeRegistryWith([ownEntry(0), foreignEntry(1)]);
			await checkCrossProcessLspBudget();
		} finally {
			delete process.env.PI_LENS_LSP_BUDGET_CEILING;
		}

		await touch("app.ts");

		expect(spawns.typescript).not.toHaveBeenCalled();
		expect(refusalRows()).toHaveLength(1);
		const reason = refusalRows()[0]?.reason ?? "";
		expect(reason).toContain(
			"the machine already runs 1 LSP servers, at or over its ceiling of 1",
		);
		// The basis is the machine's, not the root's: the root-basis wording would
		// say this session's own root was at its ceiling, and it is not.
		expect(reason).not.toContain(`${normalizeMapKey(ownRoot)} already runs`);
	});

	it("records ONE row per root, keeping the ceiling that refused it first", async () => {
		writeRegistry(ROOT_CEILING);
		await checkCrossProcessLspBudget();
		await touch("app.ts");
		expect(refusalRows()).toHaveLength(1);
		expect(refusalRows()[0]?.reason).toContain(`ceiling of ${ROOT_CEILING}`);

		// The same root is now inside its share, and the MACHINE stop is what trips:
		// a different cause, the same refusing session root.
		process.env.PI_LENS_LSP_BUDGET_CEILING = "1";
		try {
			writeRegistryWith([ownEntry(0), foreignEntry(1)]);
			await checkCrossProcessLspBudget();
		} finally {
			delete process.env.PI_LENS_LSP_BUDGET_CEILING;
		}
		await touch("script.py");

		expect(spawns.python).not.toHaveBeenCalled();
		// Still one row, and it keeps the FIRST cause, so a later machine-stop
		// refusal never reads as a missing record.
		expect(refusalRows()).toHaveLength(1);
		expect(refusalRows()[0]?.reason).toContain(`ceiling of ${ROOT_CEILING}`);
		expect(refusalRows()[0]?.reason).not.toContain("the machine already runs");
	});

	it("leaves the peer gate's answer and its one row untouched for a covered subagent that is also over budget", async () => {
		const restore = withEnv({ GENTLE_PI_AGENTS_CHILD: "1" });
		_resetSubagentModeForTests();
		try {
			_setWarmAttachForTests(ownRoot, PEER_PID, "/tmp/pi-lens-peer.sock");
			expect(
				await refreshSubagentAuxiliaryPeerCoverage({
					root: ownRoot,
					entries: [peerEntry(ownRoot)],
					now: NOW,
					isPidAlive: () => true,
				}),
			).toBe(true);
			// The session is over budget on top of being covered.
			await checkCrossProcessLspBudget({
				registry: [
					{
						...peerEntry(ownRoot),
						pid: process.pid,
						lspChildren: Array.from({ length: ROOT_CEILING }, (_, index) => ({
							pid: 1000 + index,
							serverId: "typescript",
							command: "typescript-language-server",
							spawnedAt: new Date(NOW).toISOString(),
						})),
						lspChildCount: ROOT_CEILING,
					},
				],
				isPidAlive: () => true,
				ownRoots: [ownRoot],
			});

			await touch("app.ts");

			// Nothing spawned, and the peer gate's row is the ONE record: the
			// budget door sits on the spawn path, so a covered session never
			// reaches it and cannot double-count the same skip.
			expect(spawns.typescript).not.toHaveBeenCalled();
			expect(peerDeferralRows()).toHaveLength(1);
			expect(peerDeferralRows()[0]?.subject).toBe(normalizeMapKey(ownRoot));
			expect(refusalRows()).toHaveLength(0);
		} finally {
			restore();
			_resetSubagentModeForTests();
		}
	});
});
