/**
 * Tests for the PURE decision logic in clients/lsp-budget.ts
 * (`decideLspBudget`) — #449 slice 2 prototype. All liveness checks are
 * injected fake predicates; no real process.kill/spawn/fs ever runs here.
 * Mirrors the test shape of tests/clients/instance-reaper.test.ts.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	checkCrossProcessLspBudget,
	decideLspBudget,
	DEFAULT_LSP_BUDGET_CEILING,
	DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS,
	DEFAULT_LSP_BUDGET_MACHINE_HEADROOM,
	DEFAULT_LSP_BUDGET_ROOT_CEILING,
	getLspBudgetIdleTimeoutMs,
	getLspBudgetRssCeilingBytes,
	getLspBudgetCeiling,
	getLspBudgetRootCeiling,
	isCrossProcessBudgetEnabled,
	_resetLspBudgetDecisionForTests,
	shouldDegradeAuxiliaryLsp,
	shouldPreferPullOnlyDiagnostics,
} from "../../clients/lsp-budget.js";
import {
	_resetInstanceRegistryEnabledForTests,
	type InstanceEntry,
	type LspChildEntry,
} from "../../clients/instance-registry.js";
import { removeTempDirSync } from "./test-utils.js";

function lspChild(overrides: Partial<LspChildEntry> = {}): LspChildEntry {
	return {
		pid: 1000,
		serverId: "typescript",
		command: "typescript-language-server",
		spawnedAt: new Date().toISOString(),
		...overrides,
	};
}

function instance(overrides: Partial<InstanceEntry> = {}): InstanceEntry {
	return {
		pid: 1,
		startedAt: new Date().toISOString(),
		projectRoot: "/proj",
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 0,
		heartbeatAt: new Date().toISOString(),
		...overrides,
	};
}

function alivePids(...pids: number[]): (pid: number) => boolean {
	const set = new Set(pids);
	return (pid) => set.has(pid);
}

function childrenOfCount(
	n: number,
	serverId: string,
	startPid: number,
): LspChildEntry[] {
	return Array.from({ length: n }, (_, i) =>
		lspChild({ pid: startPid + i, serverId }),
	);
}

describe("decideLspBudget", () => {
	it("under ceiling — not over budget, aux not degraded", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(3, "typescript", 100) }),
			instance({ pid: 2, lspChildren: childrenOfCount(2, "pyright", 200) }),
		];
		const decision = decideLspBudget(
			reg,
			alivePids(1, 2, 100, 101, 102, 200, 201),
			{ ownRoots: ["/proj"] },
		);

		expect(decision.totalLiveLspServers).toBe(5);
		expect(decision.ownRootLoad).toBe(5);
		expect(decision.overBudget).toBe(false);
		expect(decision.degradeAuxiliary).toBe(false);
	});

	it("at/over the root budget — over budget, aux degraded", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(10, "typescript", 100) }),
			instance({ pid: 2, lspChildren: childrenOfCount(10, "pyright", 200) }),
		];
		const decision = decideLspBudget(reg, () => true, { ownRoots: ["/proj"] });

		expect(decision.totalLiveLspServers).toBe(20);
		expect(decision.ownRootLoad).toBe(20);
		expect(decision.overBudget).toBe(true);
		expect(decision.degradeAuxiliary).toBe(true);
		expect(decision.rootCeiling).toBe(DEFAULT_LSP_BUDGET_ROOT_CEILING);
	});

	it("exactly at the root budget counts as over budget (>=, not >)", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(16, "typescript", 100) }),
		];
		const decision = decideLspBudget(reg, () => true, { ownRoots: ["/proj"] });

		expect(decision.ownRootLoad).toBe(16);
		expect(decision.overBudget).toBe(true);
	});

	it("dead-parent instances are excluded from the live count — orphan reaper's job, not double-counted here", () => {
		const reg = [
			instance({ pid: 1, lspChildren: childrenOfCount(20, "typescript", 100) }), // dead parent
			instance({ pid: 2, lspChildren: childrenOfCount(2, "pyright", 300) }), // alive parent
		];
		// Only pid 2 is alive; pid 1's children don't count toward the total.
		const decision = decideLspBudget(reg, alivePids(2), {
			ownRoots: ["/proj"],
		});

		expect(decision.totalLiveLspServers).toBe(2);
		expect(decision.ownRootLoad).toBe(2);
		expect(decision.overBudget).toBe(false);
	});

	it("#3539 verify R2-F1: another pid namespace's entry counts only while its heartbeat is fresh, never by a pid read from here", () => {
		const HOUR = 3_600_000;
		const now = Date.parse("2026-09-26T12:00:00.000Z");
		const at = (msAgo: number) => new Date(now - msAgo).toISOString();
		const foreign = (heartbeatAgoMs: number) => ({
			...instance({
				pid: 1, // alive here, whatever it is
				heartbeatAt: at(heartbeatAgoMs),
				lspChildren: childrenOfCount(16, "typescript", 100),
			}),
			pidNamespace: "pid:[container]",
		});

		const dead = decideLspBudget([foreign(7 * HOUR)], () => true, {
			ownRoots: ["/proj"],
			now,
			ownNamespace: "pid:[own]",
		});
		const live = decideLspBudget([foreign(HOUR)], () => false, {
			ownRoots: ["/proj"],
			now,
			ownNamespace: "pid:[own]",
		});

		expect(dead.totalLiveLspServers).toBe(0);
		expect(dead.degradeAuxiliary).toBe(false);
		expect(live.totalLiveLspServers).toBe(16);
	});

	it("an entry from this pid namespace is still counted by its pid", () => {
		const now = Date.parse("2026-09-26T12:00:00.000Z");
		const own = {
			...instance({
				pid: 2,
				heartbeatAt: new Date(now - 7 * 3_600_000).toISOString(),
				lspChildren: childrenOfCount(3, "typescript", 100),
			}),
			pidNamespace: "pid:[own]",
		};

		expect(
			decideLspBudget([own], alivePids(2), {
				ownRoots: ["/proj"],
				now,
				ownNamespace: "pid:[own]",
			}).totalLiveLspServers,
		).toBe(3);
		expect(
			decideLspBudget([own], alivePids(), {
				ownRoots: ["/proj"],
				now,
				ownNamespace: "pid:[own]",
			}).totalLiveLspServers,
		).toBe(0);
	});

	it("empty registry — zero load, never over budget", () => {
		const decision = decideLspBudget([], () => true);
		expect(decision.totalLiveLspServers).toBe(0);
		expect(decision.overBudget).toBe(false);
		expect(decision.degradeAuxiliary).toBe(false);
	});

	it("supplements count pressure with complete fresh aggregate RSS samples", () => {
		const now = Date.now();
		const reg = [
			instance({
				pid: 1,
				heartbeatAt: new Date(now).toISOString(),
				rssBytes: 40 * 1024 * 1024,
				lspChildren: [lspChild({ pid: 100, rssBytes: 70 * 1024 * 1024 })],
			}),
		];
		const decision = decideLspBudget(reg, () => true, {
			ownRoots: ["/proj"],
			rssCeilingBytes: 100 * 1024 * 1024,
			now,
		});

		expect(decision.totalLiveLspServers).toBe(1);
		expect(decision.totalRssBytes).toBe(110 * 1024 * 1024);
		expect(decision.rssPressure).toBe(true);
		expect(decision.overBudget).toBe(true);
		expect(decision.shortenIdleTimeout).toBe(true);
		expect(decision.preferPullOnly).toBe(true);
	});

	it("fails open to count-only when RSS samples are missing or stale", () => {
		const now = Date.now();
		for (const reg of [
			[
				instance({
					heartbeatAt: new Date(now).toISOString(),
					rssBytes: 200 * 1024 * 1024,
					lspChildren: [lspChild({ rssBytes: undefined })],
				}),
			],
			[
				instance({
					heartbeatAt: "2000-01-01T00:00:00.000Z",
					rssBytes: 200 * 1024 * 1024,
				}),
			],
		]) {
			const decision = decideLspBudget(reg, () => true, {
				rssCeilingBytes: 1,
				now,
			});
			expect(decision.totalRssBytes).toBeUndefined();
			expect(decision.rssPressure).toBe(false);
			expect(decision.overBudget).toBe(false);
		}
	});
});

describe("per-root accounting (Gentle Shell fan-out)", () => {
	const ROOT_A = "/worktrees/gentle-a";
	const ROOT_B = "/worktrees/gentle-b";

	function rootedInstance(
		pid: number,
		root: string,
		childCount: number,
		startPid: number,
		overrides: Partial<InstanceEntry> = {},
	): InstanceEntry {
		return instance({
			pid,
			projectRoot: root,
			projectRoots: [root],
			lspChildren: childrenOfCount(childCount, "typescript", startPid),
			lspChildCount: childCount,
			...overrides,
		});
	}

	it("degrades only the session whose own root is at its budget", () => {
		const reg = [
			rootedInstance(1, ROOT_A, 9, 100),
			rootedInstance(2, ROOT_A, 8, 200),
			rootedInstance(3, ROOT_B, 2, 300),
		];

		const hog = decideLspBudget(reg, () => true, { ownRoots: [ROOT_A] });
		const peer = decideLspBudget(reg, () => true, { ownRoots: [ROOT_B] });

		// Two hosts on ONE root sum to that root's load.
		expect(hog.ownRootLoad).toBe(17);
		expect(hog.ownRootOverBudget).toBe(true);
		expect(hog.degradeAuxiliary).toBe(true);
		expect(hog.shortenIdleTimeout).toBe(true);

		expect(peer.totalLiveLspServers).toBe(19);
		expect(peer.ownRootLoad).toBe(2);
		expect(peer.ownRootOverBudget).toBe(false);
		expect(peer.machineOverBudget).toBe(false);
		expect(peer.overBudget).toBe(false);
		expect(peer.degradeAuxiliary).toBe(false);
	});

	it("leaves a peer under its share alone when a fan-out of distinct roots exceeds the per-root budget machine-wide", () => {
		// Eight Gentle Shell children in eight worktrees, three servers each:
		// 24 live servers, every root well under its own budget.
		const reg = Array.from({ length: 8 }, (_, i) =>
			rootedInstance(10 + i, `/worktrees/fan-${i}`, 3, 1000 + i * 10),
		);

		const peer = decideLspBudget(reg, () => true, {
			ownRoots: ["/worktrees/fan-3"],
		});

		// The old machine-global rule compared this total against one root's
		// budget, so every session degraded.
		expect(peer.totalLiveLspServers).toBe(24);
		expect(peer.ceiling).toBe(DEFAULT_LSP_BUDGET_CEILING);
		expect(peer.totalLiveLspServers >= peer.rootCeiling).toBe(true);
		expect(peer.ownRootLoad).toBe(3);
		expect(peer.ownRootOverBudget).toBe(false);
		expect(peer.machineOverBudget).toBe(false);
		expect(peer.overBudget).toBe(false);
		expect(peer.degradeAuxiliary).toBe(false);
		expect(peer.preferPullOnly).toBe(false);
	});

	it("still degrades on the machine-wide ceiling when the total is genuinely exceeded", () => {
		// Five roots at 15 servers each: every root is under its own budget, the
		// machine is not.
		const reg = Array.from({ length: 5 }, (_, i) =>
			rootedInstance(20 + i, `/worktrees/hot-${i}`, 15, 2000 + i * 20),
		);

		const decision = decideLspBudget(reg, () => true, {
			ownRoots: ["/worktrees/hot-0"],
		});

		expect(decision.totalLiveLspServers).toBe(75);
		expect(decision.ownRootLoad).toBe(15);
		expect(decision.ownRootOverBudget).toBe(false);
		expect(decision.machineOverBudget).toBe(true);
		expect(decision.countOverBudget).toBe(true);
		expect(decision.degradeAuxiliary).toBe(true);
		expect(decision.shortenIdleTimeout).toBe(true);
		expect(decision.preferPullOnly).toBe(true);
	});

	it("counts the machine ceiling as reached at equality (>=, not >)", () => {
		const registry = [15, 15, 15, 15, 1, 1, 1, 1];
		const reg = registry.map((count, i) =>
			rootedInstance(40 + i, `/worktrees/edge-${i}`, count, 3000 + i * 20),
		);

		const decision = decideLspBudget(reg, () => true, {
			ownRoots: ["/worktrees/edge-0"],
		});

		expect(decision.totalLiveLspServers).toBe(64);
		expect(decision.machineOverBudget).toBe(true);
		expect(decision.degradeAuxiliary).toBe(true);
	});

	it("keeps the pre-split verdict when one root is the whole machine", () => {
		// The ordinary non-subagent case: exactly one live root, so the per-root
		// budget and the old machine-wide number give the same answer.
		const atBudget = decideLspBudget(
			[rootedInstance(1, ROOT_A, 16, 100)],
			() => true,
			{ ownRoots: [ROOT_A] },
		);
		const under = decideLspBudget(
			[rootedInstance(1, ROOT_A, 15, 100)],
			() => true,
			{ ownRoots: [ROOT_A] },
		);

		expect(atBudget.ownRootLoad).toBe(16);
		expect(atBudget.degradeAuxiliary).toBe(true);
		expect(under.ownRootLoad).toBe(15);
		expect(under.degradeAuxiliary).toBe(false);
	});

	it("keeps the machine-wide rule at the per-root budget when the session cannot name its own root", () => {
		const reg = [
			rootedInstance(1, ROOT_A, 10, 100),
			rootedInstance(2, ROOT_B, 10, 200),
		];

		const decision = decideLspBudget(reg, () => true, {});

		expect(decision.ownRoots).toBeUndefined();
		expect(decision.ownRootLoad).toBeUndefined();
		expect(decision.ownRootOverBudget).toBe(false);
		expect(decision.machineOverBudget).toBe(false);
		expect(decision.countOverBudget).toBe(true);
		expect(decision.degradeAuxiliary).toBe(true);
	});

	it("keeps RSS pressure machine-wide: a peer under its root budget degrades when aggregate RSS is over", () => {
		const now = Date.parse("2026-11-02T12:00:00.000Z");
		const heartbeatAt = new Date(now).toISOString();
		const reg = [
			rootedInstance(1, ROOT_A, 1, 100, {
				heartbeatAt,
				rssBytes: 200 * 1024 * 1024,
				lspChildren: [lspChild({ pid: 100, rssBytes: 10 * 1024 * 1024 })],
			}),
			rootedInstance(2, ROOT_B, 2, 200, {
				heartbeatAt,
				rssBytes: 200 * 1024 * 1024,
				lspChildren: [
					lspChild({ pid: 200, rssBytes: 10 * 1024 * 1024 }),
					lspChild({ pid: 201, rssBytes: 10 * 1024 * 1024 }),
				],
			}),
		];

		const decision = decideLspBudget(reg, () => true, {
			ownRoots: [ROOT_A],
			rssCeilingBytes: 100 * 1024 * 1024,
			now,
		});

		expect(decision.ownRootOverBudget).toBe(false);
		expect(decision.machineOverBudget).toBe(false);
		expect(decision.rssPressure).toBe(true);
		expect(decision.degradeAuxiliary).toBe(true);
	});
});

describe("getLspBudgetCeiling / isCrossProcessBudgetEnabled (env config)", () => {
	const ORIGINAL_ENV = { ...process.env };

	afterEach(() => {
		process.env = { ...ORIGINAL_ENV };
	});

	it("defaults to DEFAULT_LSP_BUDGET_CEILING when unset", () => {
		delete process.env.PI_LENS_LSP_BUDGET_CEILING;
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
	});

	it("keeps the machine stop above one root's budget, and honors a root override", () => {
		delete process.env.PI_LENS_LSP_BUDGET_CEILING;
		delete process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING;
		expect(DEFAULT_LSP_BUDGET_CEILING).toBe(
			DEFAULT_LSP_BUDGET_ROOT_CEILING * DEFAULT_LSP_BUDGET_MACHINE_HEADROOM,
		);
		expect(getLspBudgetRootCeiling()).toBe(DEFAULT_LSP_BUDGET_ROOT_CEILING);
		process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING = "4";
		expect(getLspBudgetRootCeiling()).toBe(4);
		process.env.PI_LENS_LSP_BUDGET_ROOT_CEILING = "0";
		expect(getLspBudgetRootCeiling()).toBe(DEFAULT_LSP_BUDGET_ROOT_CEILING);
	});

	it("honors a valid positive override", () => {
		process.env.PI_LENS_LSP_BUDGET_CEILING = "8";
		expect(getLspBudgetCeiling()).toBe(8);
	});

	it("falls back to default on a non-finite/zero/negative override (NaN guard)", () => {
		process.env.PI_LENS_LSP_BUDGET_CEILING = "not-a-number";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
		process.env.PI_LENS_LSP_BUDGET_CEILING = "0";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
		process.env.PI_LENS_LSP_BUDGET_CEILING = "-5";
		expect(getLspBudgetCeiling()).toBe(DEFAULT_LSP_BUDGET_CEILING);
	});

	it("enabled by default; PI_LENS_CROSS_PROCESS_BUDGET=0 disables", () => {
		delete process.env.PI_LENS_CROSS_PROCESS_BUDGET;
		expect(isCrossProcessBudgetEnabled()).toBe(true);
		process.env.PI_LENS_CROSS_PROCESS_BUDGET = "0";
		expect(isCrossProcessBudgetEnabled()).toBe(false);
	});

	it("keeps RSS pressure off by default and honors positive MB overrides", () => {
		delete process.env.PI_LENS_LSP_BUDGET_RSS_MB;
		expect(getLspBudgetRssCeilingBytes()).toBeUndefined();
		process.env.PI_LENS_LSP_BUDGET_RSS_MB = "512";
		expect(getLspBudgetRssCeilingBytes()).toBe(512 * 1024 * 1024);
		process.env.PI_LENS_LSP_BUDGET_RSS_MB = "invalid";
		expect(getLspBudgetRssCeilingBytes()).toBeUndefined();
	});

	it("uses a 60s pressure idle default and honors a positive override", () => {
		delete process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS;
		expect(getLspBudgetIdleTimeoutMs()).toBe(
			DEFAULT_LSP_BUDGET_IDLE_TIMEOUT_MS,
		);
		process.env.PI_LENS_LSP_BUDGET_IDLE_TIMEOUT_MS = "30000";
		expect(getLspBudgetIdleTimeoutMs()).toBe(30_000);
	});
});

describe("shouldDegradeAuxiliaryLsp (module-scope decision cache)", () => {
	beforeEach(() => {
		_resetLspBudgetDecisionForTests();
	});

	it("defaults to false before any check has run — fail toward today's behavior", () => {
		expect(shouldDegradeAuxiliaryLsp()).toBe(false);
	});

	it("replaces the cached decision at every session-start check", async () => {
		const previousRegistry = process.env.PI_LENS_INSTANCE_REGISTRY;
		const previousBudget = process.env.PI_LENS_CROSS_PROCESS_BUDGET;
		delete process.env.PI_LENS_INSTANCE_REGISTRY;
		delete process.env.PI_LENS_CROSS_PROCESS_BUDGET;
		_resetInstanceRegistryEnabledForTests();
		try {
			const root = "/worktrees/session-start";
			const pressured = [
				instance({
					pid: process.pid,
					projectRoot: root,
					projectRoots: [root],
					lspChildren: childrenOfCount(20, "typescript", 100),
				}),
			];
			await checkCrossProcessLspBudget({
				registry: pressured,
				isPidAlive: () => true,
				ownRoots: [root],
			});
			expect(shouldDegradeAuxiliaryLsp()).toBe(true);
			expect(shouldPreferPullOnlyDiagnostics()).toBe(true);

			const calm = [
				instance({
					pid: process.pid,
					projectRoot: root,
					projectRoots: [root],
					lspChildren: childrenOfCount(1, "typescript", 100),
				}),
			];
			await checkCrossProcessLspBudget({
				registry: calm,
				isPidAlive: () => true,
				ownRoots: [root],
			});
			expect(shouldDegradeAuxiliaryLsp()).toBe(false);
			expect(shouldPreferPullOnlyDiagnostics()).toBe(false);
		} finally {
			_resetLspBudgetDecisionForTests();
			if (previousRegistry === undefined) {
				delete process.env.PI_LENS_INSTANCE_REGISTRY;
			} else {
				process.env.PI_LENS_INSTANCE_REGISTRY = previousRegistry;
			}
			if (previousBudget === undefined) {
				delete process.env.PI_LENS_CROSS_PROCESS_BUDGET;
			} else {
				process.env.PI_LENS_CROSS_PROCESS_BUDGET = previousBudget;
			}
			_resetInstanceRegistryEnabledForTests();
		}
	});

	it("caches pressure from a fabricated registry file at the boundary", async () => {
		const tmp = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-budget-registry-"),
		);
		const previousHome = process.env.PI_LENS_HOME;
		const previousCeiling = process.env.PI_LENS_LSP_BUDGET_CEILING;
		process.env.PI_LENS_HOME = tmp;
		process.env.PI_LENS_LSP_BUDGET_CEILING = "1";
		_resetInstanceRegistryEnabledForTests();
		fs.writeFileSync(
			path.join(tmp, "instances.json"),
			JSON.stringify({
				instances: [
					instance({
						pid: process.pid,
						lspChildren: [lspChild({ pid: process.pid + 1 })],
					}),
				],
			}),
			"utf8",
		);

		try {
			await checkCrossProcessLspBudget();
			expect(shouldDegradeAuxiliaryLsp()).toBe(true);
			expect(shouldPreferPullOnlyDiagnostics()).toBe(true);
		} finally {
			_resetLspBudgetDecisionForTests();
			_resetInstanceRegistryEnabledForTests();
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			if (previousCeiling === undefined) {
				delete process.env.PI_LENS_LSP_BUDGET_CEILING;
			} else {
				process.env.PI_LENS_LSP_BUDGET_CEILING = previousCeiling;
			}
			removeTempDirSync(tmp);
		}
	});
});
