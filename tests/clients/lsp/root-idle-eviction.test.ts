// flake-shape: in-process-mock — createLSPClient wraps the language-server child process (JSON-RPC over stdio), and no shared client double exists: SERVICE_SURFACES registers no factory for LSPClientInfo (tests/support/flake-shape-scan.ts). The subject here is the registry's idle policy over a client whose shutdown is observable at a chosen bound on a fake clock, which a real server child cannot be made to give on demand.
// flake-shape: service-double — a language-server client is a spawned process; the per-client release is driven by its liveness and busy answers at `ROOT_IDLE_MS`, and only a double can be held idle for exactly one fake-clock tick.
/**
 * T4 (G4) of odd/tasks/lsp-fleet-memory — the two idle-eviction layers become
 * ONE decision. Before this slice only a `transparent` server (the 20-minute
 * measured window), an adopted root and an ephemeral root carried a per-client
 * bound; every other root's clients waited for the process-wide fleet reset
 * armed by `handleTurnEnd`, which tears the whole generation down on a quiet
 * session rather than per client.
 *
 * The subject is the REAL `LSPService` and its client registry, as in
 * `idle-eviction.test.ts`: only the launched binary (`createLSPClient`) is
 * doubled, so an eviction is observed on the client object the service holds
 * and in the degradation ledger the release is recorded in.
 *
 * Four properties, and which layer owns each:
 *
 * - a root whose servers are `unmeasured` (the registry's default, and every
 *   non-`transparent` built-in) is released PER CLIENT at its own root idle
 *   bound, under its own record kind, with the transparent window far away so
 *   the case can only pass on the new policy;
 * - a `resident` server keeps no per-client timer at all: its declaration is
 *   deliberate, and the fleet reset stays its only bound (the excluded
 *   default, stated rather than silently narrowed);
 * - a client its owner used again is not released: the per-client policy is
 *   armed by USE, not by a session turn, which is why it needs no
 *   primary-session guard of its own (the fleet reset keeps that guard, pinned
 *   by `tests/clients/runtime-turn-session.test.ts`);
 * - a session whose answers come from a LIVE PEER's server reaches none of
 *   this: no local client is created, so nothing of the peer's can be closed,
 *   stolen or evicted (the cross-process rule T1/T3 already respect).
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { normalizeMapKey } from "../../../clients/path-utils.js";
import { pinFixtureHome } from "../test-utils.js";

const getServersForFileWithConfig = vi.fn();
const createLSPClient = vi.fn();

// Only the client TRANSPORT is doubled: every other export of the client module
// stays the real one, so a production route that reaches them does not fail with
// "not a function" (the vi-mock-export ratchet exists for that regression).
vi.mock("../../../clients/lsp/client.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../clients/lsp/client.js")>()),
	createLSPClient,
}));

/** The root the case's files live under: absolute, outside tmp, not ephemeral. */
const ROOT = "/pi-lens-t4-root";
/** The per-client root idle bound this case arms, in milliseconds. */
const ROOT_IDLE_MS = 20;
/**
 * The `transparent` window, deliberately five orders of magnitude away from the
 * bound under test. A client released inside this case therefore cannot have
 * been released by the measured `transparent` policy.
 */
const TRANSPARENT_WINDOW_MS = 500_000;

const ROOT_IDLE_ENV = "PI_LENS_LSP_ROOT_IDLE_EVICT_MS";

function fakeClient(label: string, busy = false) {
	return {
		label,
		root: ROOT,
		isAlive: vi.fn(() => true),
		isBusy: vi.fn(() => busy),
		shutdown: vi.fn(async () => undefined),
		notify: {
			open: vi.fn(async () => undefined),
			change: vi.fn(async () => undefined),
		},
		diagnosticsVersion: 0,
		getWorkspaceDiagnosticsSupport: vi.fn(() => ({
			advertised: false,
			mode: "push-only",
			diagnosticProviderKind: "unavailable",
		})),
	};
}

function configureServer(
	id = "ts",
	policy: "transparent" | "resident" | "unmeasured" = "unmeasured",
	root = ROOT,
) {
	const spawn = vi.fn(async () => ({
		process: {
			process: { killed: false },
			stdin: {},
			stdout: {},
			stderr: {},
			pid: 1332,
		},
	}));
	getServersForFileWithConfig.mockReturnValue([
		{
			id,
			name: id,
			extensions: [".ts"],
			idleEviction: policy,
			root: async () => root,
			spawn,
		},
	]);
	return spawn;
}

function groupOf(kind: string) {
	return getDegradationSummary().find((group) => group.kind === kind);
}

let getDegradationSummary: (typeof import("../../../clients/degradation-ledger.js"))["getDegradationSummary"];

describe("a non-transparent root carries its own per-client idle bound (T4/G4)", () => {
	let home: { restore: () => void } | undefined;

	beforeEach(async () => {
		vi.resetModules();
		const config = await import("../../../clients/lsp/config.js");
		config._setServersForFileForTests(getServersForFileWithConfig);
		const ledger = await import("../../../clients/degradation-ledger.js");
		ledger.resetDegradationLedger();
		getDegradationSummary = ledger.getDegradationSummary;
		getServersForFileWithConfig.mockReset();
		createLSPClient.mockReset();
		home = pinFixtureHome("pi-lens-t4-root-idle");
		process.env[ROOT_IDLE_ENV] = String(ROOT_IDLE_MS);
		process.env.PI_LENS_LSP_IDLE_EVICT_MS = String(TRANSPARENT_WINDOW_MS);
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
		delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
	});

	afterEach(() => {
		delete process.env[ROOT_IDLE_ENV];
		delete process.env.PI_LENS_LSP_IDLE_EVICT_MS;
		delete process.env.PI_LENS_TS_IDLE_EVICT_MS;
		delete process.env.PI_LENS_EPHEMERAL_LSP_IDLE_EVICT_MS;
		home?.restore();
		home = undefined;
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("releases an unmeasured server's client at the root idle bound, under its own record", async () => {
		vi.useFakeTimers();
		const first = fakeClient("first");
		const rebuilt = fakeClient("rebuilt");
		createLSPClient.mockResolvedValueOnce(first).mockResolvedValueOnce(rebuilt);
		const spawn = configureServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		const entry = await service.getClientForFile(`${ROOT}/main.ts`);
		expect(entry?.client).toBe(first);
		expect(entry?.info.idleEviction).toBe("unmeasured");

		// One tick short of the bound: still serving.
		await vi.advanceTimersByTimeAsync(ROOT_IDLE_MS - 1);
		expect(first.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(1);

		// The observation this case exists for: the client is released by ITS OWN
		// timer, at the root bound, not by a whole-fleet reset.
		expect(first.shutdown).toHaveBeenCalledWith({ reason: "idle_eviction" });
		expect(service.getAliveClientCount()).toBe(0);

		// One bounded record naming the layer, the root and the bound that elapsed.
		const rootIdle = groupOf("lsp-root-idle-eviction");
		expect(rootIdle?.count).toBe(1);
		expect(rootIdle?.latestReasons).toEqual([
			{
				subject: `ts:${normalizeMapKey(ROOT)}`,
				reason: expect.stringContaining(String(ROOT_IDLE_MS)),
			},
		]);
		expect(rootIdle?.latestReasons[0]?.reason).toContain(normalizeMapKey(ROOT));
		// The transparent release is a DIFFERENT layer's record and must stay empty,
		// so a reader can tell which one decided.
		expect(groupOf("lsp-idle-eviction")).toBeUndefined();
		expect(groupOf("lsp-idle-eviction-declined")).toBeUndefined();

		// Transparent rebuild: the next request starts a fresh client generation.
		expect((await service.getClientForFile(`${ROOT}/main.ts`))?.client).toBe(
			rebuilt,
		);
		expect(spawn).toHaveBeenCalledTimes(2);
		expect(createLSPClient).toHaveBeenCalledTimes(2);
		await service.shutdown();
	});

	it("leaves a `resident` server to the whole-fleet reset, with its unchanged decline record", async () => {
		vi.useFakeTimers();
		const client = fakeClient("resident");
		createLSPClient.mockResolvedValue(client);
		configureServer("ts-resident", "resident");
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		await service.getClientForFile(`${ROOT}/main.ts`);

		await vi.advanceTimersByTimeAsync(ROOT_IDLE_MS * 5);

		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);
		expect(groupOf("lsp-root-idle-eviction")).toBeUndefined();
		// The declared refusal is unchanged, so the nightly probe still reads a
		// policy answer rather than an arm that never reached the policy.
		expect(groupOf("lsp-idle-eviction-declined")?.latestReasons).toEqual([
			{
				subject: "ts-resident",
				reason: "no idle-eviction timer: declared resident",
			},
		]);
		await service.shutdown();
	});

	it("does not release a client its owner used again inside the bound", async () => {
		vi.useFakeTimers();
		const client = fakeClient("used-again");
		createLSPClient.mockResolvedValue(client);
		configureServer();
		const { LSPService } = await import("../../../clients/lsp/index.js");
		const service = new LSPService();

		await service.getClientForFile(`${ROOT}/main.ts`);
		await vi.advanceTimersByTimeAsync(ROOT_IDLE_MS - 1);
		// The owner touches it again: the bound restarts from THIS use. This is the
		// property that lets the per-client policy run without the fleet reset's
		// primary-session guard — a fleet in use is never idle.
		await service.getClientForFile(`${ROOT}/main.ts`);
		await vi.advanceTimersByTimeAsync(ROOT_IDLE_MS - 1);
		expect(client.shutdown).not.toHaveBeenCalled();
		expect(service.getAliveClientCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(1);
		expect(client.shutdown).toHaveBeenCalledTimes(1);
		await service.shutdown();
	});

	it("never reaches a live peer's server: a covered session owns no client of that root", async () => {
		// A real registry home, so the peer's own registration is a file this case
		// can read back rather than an in-memory claim.
		const registryHome = fs.mkdtempSync(
			path.join(os.tmpdir(), "pi-lens-t4-peers-"),
		);
		const previousHome = process.env.PI_LENS_HOME;
		process.env.PI_LENS_HOME = registryHome;
		const peerRoot = path.join(registryHome, "peer-root");
		fs.mkdirSync(peerRoot, { recursive: true });
		const instancesPath = path.join(registryHome, "instances.json");
		const peerEntry = {
			pid: process.ppid,
			startedAt: new Date(Date.now() - 60_000).toISOString(),
			projectRoot: peerRoot,
			projectRoots: [peerRoot],
			lspChildren: [
				{
					pid: process.ppid,
					serverId: "typescript",
					command: "typescript-language-server",
					spawnedAt: new Date(Date.now() - 60_000).toISOString(),
				},
			],
			lspChildCount: 1,
			rssBytes: 0,
			heartbeatAt: new Date().toISOString(),
		};
		fs.writeFileSync(instancesPath, JSON.stringify({ instances: [peerEntry] }));
		const registered = fs.readFileSync(instancesPath, "utf8");
		try {
			vi.useFakeTimers();
			const restoreChild = { value: process.env.GENTLE_PI_AGENTS_CHILD };
			process.env.GENTLE_PI_AGENTS_CHILD = "1";
			const subagent = await import("../../../clients/subagent-mode.js");
			const auxiliary =
				await import("../../../clients/dispatch/auxiliary-lsp.js");
			const warm = await import("../../../clients/warm-attach.js");
			const roots = await import("../../../clients/lsp/session-roots.js");
			const trust = await import("../../../clients/project-trust.js");
			const registry = await import("../../../clients/instance-registry.js");
			try {
				subagent._resetSubagentModeForTests();
				trust.setProjectTrustState("trusted");
				roots.registerSessionRoot(peerRoot);
				warm._resetWarmAttachForTests();
				registry._resetInstanceRegistryEnabledForTests();
				auxiliary._resetSubagentAuxiliaryPeerCoverageForTests();

				// The premise: this session's answers come from that live peer on its
				// EXACT root, through a published endpoint.
				warm._setWarmAttachForTests(peerRoot, process.ppid, "/tmp/peer.sock");
				expect(
					await auxiliary.refreshSubagentAuxiliaryPeerCoverage({
						root: peerRoot,
						entries: [peerEntry],
						now: Date.now(),
						isPidAlive: () => true,
					}),
				).toBe(true);

				const spawn = configureServer("typescript", "unmeasured", peerRoot);
				const { LSPService } = await import("../../../clients/lsp/index.js");
				const service = new LSPService();
				const file = path.join(peerRoot, "app.ts");
				fs.writeFileSync(file, "const value = 1;\n");

				await service.touchFile(file, "const value = 1;\n", {
					diagnostics: "none",
					clientScope: "primary",
					source: "lsp_sync",
				});
				// No client of this root exists here: the fleet the idle policy could
				// release is empty, and the server answering is the peer's process.
				expect(spawn).not.toHaveBeenCalled();
				expect(createLSPClient).not.toHaveBeenCalled();
				expect(service.getAliveClientCount()).toBe(0);

				// Long past every bound this session arms.
				await vi.advanceTimersByTimeAsync(ROOT_IDLE_MS * 10);

				// Nothing was closed, recorded or stolen on the peer's behalf.
				expect(spawn).not.toHaveBeenCalled();
				expect(createLSPClient).not.toHaveBeenCalled();
				expect(service.getAliveClientCount()).toBe(0);
				expect(groupOf("lsp-root-idle-eviction")).toBeUndefined();
				// The peer's registration is byte-identical: it still names its own
				// typescript child for that root.
				expect(fs.readFileSync(instancesPath, "utf8")).toBe(registered);
				await service.shutdown();
			} finally {
				auxiliary?._resetSubagentAuxiliaryPeerCoverageForTests?.();
				if (restoreChild.value === undefined)
					delete process.env.GENTLE_PI_AGENTS_CHILD;
				else process.env.GENTLE_PI_AGENTS_CHILD = restoreChild.value;
			}
		} finally {
			if (previousHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = previousHome;
			fs.rmSync(registryHome, { recursive: true, force: true });
		}
	});

	it("keeps the bound in one place: the fleet reset reads the same derivation", async () => {
		const { getRootIdleEvictMs, DEFAULT_ROOT_IDLE_EVICT_MS } =
			await import("../../../clients/lsp/client-registry.js");
		const { getEffectiveLspIdleResetMs } =
			await import("../../../clients/runtime-turn.js");
		const { getFullScanWallClockMs, SWEEP_IDLE_SAFETY_MARGIN_MS } =
			await import("../../../clients/lsp/workspace-sweep-hold.js");
		delete process.env[ROOT_IDLE_ENV];
		// The per-client bound outlives a full workspace sweep on purpose (#1618
		// acceptance criterion 6): a client may not be released mid-sweep.
		const expected = Math.max(
			DEFAULT_ROOT_IDLE_EVICT_MS,
			getFullScanWallClockMs() + SWEEP_IDLE_SAFETY_MARGIN_MS,
		);
		expect(getRootIdleEvictMs()).toBe(expected);
		expect(DEFAULT_ROOT_IDLE_EVICT_MS).toBe(240_000);
		// The whole-fleet reset is the backstop for this bound, never a shorter
		// independent constant that could fire first.
		expect(getEffectiveLspIdleResetMs()).toBeGreaterThanOrEqual(
			getRootIdleEvictMs(),
		);
	});
});
