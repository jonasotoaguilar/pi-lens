import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../clients/degradation-ledger.js";
import {
	type InstanceEntry,
	readInstanceRegistry,
	registerInstance,
} from "../../clients/instance-registry.js";
import {
	boundUnixSocketPath,
	diagnosticsIpcPathForCwd,
	WARM_DIAGNOSTICS_SCHEMA_VERSION,
} from "../../clients/mcp/ipc.js";
import { STALE_HEARTBEAT_MS } from "../../clients/instance-reaper.js";
import { normalizeFilePath } from "../../clients/path-utils.js";
import {
	configureWarmAttach,
	selectWarmAttachIncumbent,
} from "../../clients/warm-attach.js";
import { getRecentLoggedPhases } from "../../clients/latency-logger.js";
import {
	_resetWarmAttachForTests,
	_setWarmAttachForTests,
	_setWarmAttachSocketModeForTests,
	_warmAttachServerForTests,
	isWarmAttached,
	tryWarmAttachedCodeActions,
	tryWarmAttachedDiagnostics,
	warmAttachAttachment,
} from "../../clients/warm-attach.js";
import { _resetSubagentModeForTests } from "../../clients/subagent-mode.js";
import {
	connectOutcome,
	plantStaleUnixSocket,
	removeTempDirSync,
	setupTestEnvironment,
} from "./test-utils.js";

/**
 * Close a test server and WAIT for the close to finish: `close()` reports its
 * completion through a callback (or a promise in Node 20+), and the handle
 * outlives the case when nothing awaits that. The only call site is the
 * teardown hook below, which is async for this reason.
 */
async function closeServer(server: net.Server | undefined): Promise<void> {
	if (!server) return;
	(
		server as net.Server & { closeAllConnections?: () => void }
	).closeAllConnections?.();
	await new Promise<void>((resolve) => server.close(() => resolve()));
}

function entry(pid: number, root: string, heartbeatAt: string): InstanceEntry {
	return {
		pid,
		startedAt: heartbeatAt,
		projectRoot: normalizeFilePath(root),
		lspChildren: [],
		lspChildCount: 0,
		rssBytes: 1,
		heartbeatAt,
	};
}

/**
 * #713 premise 2: the auxiliary-skip gate asks WHAT this process is attached
 * to, not only whether it is attached. `isWarmAttached()` and the accessor are
 * one predicate — the boolean is the accessor's presence — so the two can
 * never answer differently. The root is stored as configured, so a caller
 * comparing roots compares the tree this session attached for.
 */
describe("warmAttachAttachment", () => {
	const cwd = path.resolve("/repo/warm-attach-attachment");

	afterEach(() => {
		_resetWarmAttachForTests();
	});

	it("reports no attachment while this process runs its own servers", () => {
		expect(warmAttachAttachment()).toBeUndefined();
		expect(isWarmAttached()).toBe(false);
	});

	it("reports the root and the incumbent it reads from", () => {
		_setWarmAttachForTests(cwd, 4_321);
		expect(warmAttachAttachment()).toEqual({
			root: cwd,
			incumbentPid: 4_321,
			endpointPublished: false,
		});
		expect(isWarmAttached()).toBe(true);
	});

	it("reports whether the incumbent published the endpoint it bound", () => {
		// The fleet gates read this: an attachment that names a live pid but no
		// bound endpoint is not a fleet anybody answers from (T1 of
		// odd/tasks/lsp-fleet-memory).
		_setWarmAttachForTests(cwd, 4_321, "/tmp/pi-lens-incumbent.sock");
		expect(warmAttachAttachment()).toEqual({
			root: cwd,
			incumbentPid: 4_321,
			endpointPublished: true,
		});
	});

	it("drops the attachment when a dead incumbent promotes the session to local", async () => {
		_setWarmAttachForTests(cwd, 999_999);
		await tryWarmAttachedDiagnostics("app.ts", "x", 10);
		expect(warmAttachAttachment()).toBeUndefined();
		expect(isWarmAttached()).toBe(false);
	});
});

// S2 of odd/tasks/lsp-fleet-memory: warm attach is the PLUGIN's decision now.
// Every session binds and publishes its own diagnostics endpoint, because a
// child can only stop paying for a primary language server when something
// answers for its root; a SUBAGENT attaches to a live same-root peer that
// published where it listens. A primary session never attaches implicitly — it
// owns its fleet — and `PI_LENS_WARM_ATTACH=0` opts back out.
describe("configureWarmAttach decides participation without user configuration", () => {
	/** This process's parent: a real live pid that is never `process.pid`. */
	const PEER_PID = process.ppid;
	const savedHome = process.env.PI_LENS_HOME;
	const savedOptIn = process.env.PI_LENS_WARM_ATTACH;
	const savedTmpDir = process.env.TMPDIR;
	let tmpDir: string;
	let home: string;
	let root: string;

	beforeEach(() => {
		tmpDir = setupTestEnvironment("pi-lens-wa-default-").tmpDir;
		home = path.join(tmpDir, "home");
		root = path.join(tmpDir, "ws");
		fs.mkdirSync(home, { recursive: true });
		fs.mkdirSync(root, { recursive: true });
		process.env.PI_LENS_HOME = home;
		// The installed default: neither "1" nor "0".
		delete process.env.PI_LENS_WARM_ATTACH;
		// The bound endpoint lives under `os.tmpdir()`, so point it INSIDE the
		// fixture: a case that binds and leaves would otherwise strand a socket
		// file at the shared tmp root, which no sweep of this file can remove.
		process.env.TMPDIR = tmpDir;
		_resetWarmAttachForTests();
		resetDegradationLedger();
	});

	afterEach(() => {
		_resetWarmAttachForTests();
		vi.unstubAllEnvs();
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		if (savedOptIn === undefined) delete process.env.PI_LENS_WARM_ATTACH;
		else process.env.PI_LENS_WARM_ATTACH = savedOptIn;
		if (savedTmpDir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = savedTmpDir;
		_resetSubagentModeForTests();
		resetDegradationLedger();
	});

	/** A live peer entry for `root`, publishing its endpoint only when given. */
	function writePeer(diagnosticsEndpoint?: string): void {
		fs.writeFileSync(
			path.join(home, "instances.json"),
			JSON.stringify({
				instances: [
					{
						...entry(PEER_PID, root, new Date().toISOString()),
						...(diagnosticsEndpoint === undefined
							? {}
							: { diagnosticsEndpoint }),
					},
				],
			}),
		);
	}

	function bindSubagent(): void {
		vi.stubEnv("GENTLE_PI_AGENTS_CHILD", "1");
		_resetSubagentModeForTests();
	}

	it("binds its own endpoint and stays local in a primary session", async () => {
		writePeer(boundUnixSocketPath(diagnosticsIpcPathForCwd(root, PEER_PID)));

		await configureWarmAttach(root);

		// It bound: a subagent of this session has a real incumbent to borrow.
		expect(_warmAttachServerForTests()).toBeDefined();
		// It did not attach: a primary session owns its fleet.
		expect(isWarmAttached()).toBe(false);
		expect(warmAttachAttachment()).toBeUndefined();
	});

	it("attaches a subagent to a peer that published the endpoint it bound", async () => {
		bindSubagent();
		const published = boundUnixSocketPath(
			diagnosticsIpcPathForCwd(root, PEER_PID),
		);
		writePeer(published);

		await configureWarmAttach(root);

		expect(warmAttachAttachment()).toEqual({
			root,
			incumbentPid: PEER_PID,
			endpointPublished: true,
		});
	});

	it("keeps a subagent local when the peer published no endpoint", async () => {
		bindSubagent();
		writePeer();

		await configureWarmAttach(root);

		// Nothing proves a listener exists there, so borrowing would obtain
		// nothing: run our own fleet instead.
		expect(isWarmAttached()).toBe(false);
		expect(_warmAttachServerForTests()).toBeDefined();
	});

	// POSIX only: Windows binds a named pipe, which has no file mode to restrict.
	// Lane: the Linux and macOS unit lanes; no win32 gate covers it.
	it.skipIf(process.platform === "win32")(
		"binds the diagnostics endpoint owner-only",
		async () => {
			await configureWarmAttach(root);

			// The endpoint carries file BYTES to whoever may connect. Node creates the
			// socket with `0777 & ~umask`, so a host with `umask 002` would expose it
			// to every local user; the binder narrows it to the owner.
			const bound = boundUnixSocketPath(
				diagnosticsIpcPathForCwd(root, process.pid),
			);
			expect(fs.statSync(bound).mode & 0o777).toBe(0o600);
			expect(_warmAttachServerForTests()).toBeDefined();
		},
	);

	// POSIX only, same reason as above.
	it.skipIf(process.platform === "win32")(
		"publishes no listener it cannot restrict",
		async () => {
			// A host where the mode cannot be narrowed is a host where the endpoint
			// would be readable by other local users. Fall back instead of exposing
			// it: no listener, no published endpoint, and this session runs its own
			// fleet (which is also what its children already do).
			_setWarmAttachSocketModeForTests(() => {
				throw Object.assign(new Error("EPERM: chmod not permitted"), {
					code: "EPERM",
				});
			});

			await configureWarmAttach(root);

			expect(_warmAttachServerForTests()).toBeUndefined();
			expect(isWarmAttached()).toBe(false);
			expect(
				getDegradationSummary().find(
					(group) => group.kind === "warm-attach-socket-mode-unrestricted",
				)?.count,
			).toBe(1);
			await registerInstance(root);
			const own = (await readInstanceRegistry()).find(
				(candidate) => candidate.pid === process.pid,
			);
			expect(own?.diagnosticsEndpoint).toBeUndefined();
		},
	);

	it("binds nothing when the operator opts out", async () => {
		vi.stubEnv("PI_LENS_WARM_ATTACH", "0");
		bindSubagent();
		writePeer(boundUnixSocketPath(diagnosticsIpcPathForCwd(root, PEER_PID)));

		await configureWarmAttach(root);

		expect(_warmAttachServerForTests()).toBeUndefined();
		expect(isWarmAttached()).toBe(false);
		// The opt-out is a decision, so it writes its own row under the phase a
		// reader greps for, and the reason names this arm.
		expect(
			getRecentLoggedPhases().some(
				(row) =>
					row.phase === "lsp_warm_attach" && row.metadata?.reason === "opt-out",
			),
		).toBe(true);
	});
});

describe("selectWarmAttachIncumbent", () => {
	const now = Date.now();
	const cwd = "C:\\work\\same-root";

	it("selects a PID-confirmed live same-root incumbent", () => {
		const incumbent = entry(11, cwd, new Date(now).toISOString());
		expect(
			selectWarmAttachIncumbent([incumbent], cwd, now, () => true)?.pid,
		).toBe(11);
	});

	it("rejects stale, dead, different-root, and absent incumbents", () => {
		const stale = entry(
			11,
			cwd,
			new Date(now - STALE_HEARTBEAT_MS - 1).toISOString(),
		);
		const dead = entry(12, cwd, new Date(now).toISOString());
		const other = entry(13, "C:\\work\\other", new Date(now).toISOString());
		expect(
			selectWarmAttachIncumbent(
				[stale, dead, other],
				cwd,
				now,
				(pid) => pid !== 12,
			),
		).toBeUndefined();
		expect(selectWarmAttachIncumbent([], cwd, now, () => true)).toBeUndefined();
	});

	it("permanently promotes to local when the incumbent disappears", async () => {
		_setWarmAttachForTests(cwd, 999_999);
		expect(isWarmAttached()).toBe(true);
		await tryWarmAttachedDiagnostics("app.ts", "x", 10);
		expect(isWarmAttached()).toBe(false);
		await tryWarmAttachedDiagnostics("app.ts", "x", 10);
		expect(isWarmAttached()).toBe(false);
		_resetWarmAttachForTests();
	});

	it("does not promote when optional code-action enrichment fails", async () => {
		_setWarmAttachForTests(cwd, 999_998);
		expect(isWarmAttached()).toBe(true);
		const result = await tryWarmAttachedCodeActions(
			"app.ts",
			"diagnostics-hash",
			[],
			10,
		);
		expect(result?.available).toBe(false);
		expect(isWarmAttached()).toBe(true);
		_resetWarmAttachForTests();
	});
});

/**
 * #3255 H1. Narrowing the case fold moved the derived endpoint bytes, so a peer
 * that registered BEFORE the upgrade is still alive and still listening on its
 * old pid-scoped socket while this process derives the new one. Round 1 shipped
 * that as an ordinary promote-to-local: the session silently lost its warm
 * incumbent with nothing a user could read. The ledger entry is what
 * `/lens-perf` renders (index.ts:1550, the same renderer `pilens_health` uses),
 * so this is the existing surface, not a new one.
 */
describe("warm-attach records a missing incumbent endpoint (#3255)", () => {
	let home: string;
	const savedHome = process.env.PI_LENS_HOME;
	const root = path.resolve("/repo/warm-attach-3255");

	beforeEach(() => {
		home = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-warm-3255-"));
		process.env.PI_LENS_HOME = home;
		// A live, same-root incumbent the registry confirms. It must be a real
		// live pid that is NOT this process — `selectLivePeerInstances` excludes
		// `process.pid` by definition, so the parent is the honest stand-in and
		// `isPidAlive` stays the production one, unmocked. Nothing listens on the
		// endpoint derived for it: exactly the upgrade-stranded shape.
		fs.writeFileSync(
			path.join(home, "instances.json"),
			JSON.stringify({
				instances: [entry(process.ppid, root, new Date().toISOString())],
			}),
		);
		resetDegradationLedger();
		_setWarmAttachForTests(root, process.ppid);
	});

	afterEach(() => {
		_resetWarmAttachForTests();
		resetDegradationLedger();
		if (savedHome === undefined) delete process.env.PI_LENS_HOME;
		else process.env.PI_LENS_HOME = savedHome;
		removeTempDirSync(home);
	});

	it("records the missing endpoint exactly once across repeated calls", async () => {
		await tryWarmAttachedDiagnostics("app.ts", "x", 200);
		await tryWarmAttachedDiagnostics("app.ts", "x", 200);

		const group = getDegradationSummary().find(
			(candidate) => candidate.kind === "warm-ipc-endpoint-missing",
		);
		expect(group?.count).toBe(1);
		// The reason has to name the remedy, not just the failure: after an
		// upgrade the incumbent is alive and answering on its PREVIOUS endpoint
		// name, so "no peer" would send the reader looking for a dead process.
		expect(group?.latestReasons[0]?.reason).toMatch(/restart/i);
		expect(isWarmAttached()).toBe(false);
	});

	it("does not record it when the incumbent is listening but slow", async () => {
		// The negative direction of the same discriminator. A reachable incumbent
		// that misses the deadline is a TIMEOUT: restarting it is the wrong advice
		// and a ledger entry here would be noise on a healthy warm path.
		const endpoint = diagnosticsIpcPathForCwd(root, process.ppid);
		if (process.platform !== "win32") {
			try {
				fs.unlinkSync(endpoint);
			} catch {
				/* none */
			}
		}
		const silent = net.createServer(() => {
			// Accept and never answer.
		});
		await new Promise<void>((resolve) => silent.listen(endpoint, resolve));
		try {
			await tryWarmAttachedDiagnostics("app.ts", "x", 30);
			expect(
				getDegradationSummary().find(
					(candidate) => candidate.kind === "warm-ipc-endpoint-missing",
				),
			).toBeUndefined();
			// Still promoted — the session gave up on the incumbent either way; it
			// is the ADVICE that differs.
			expect(isWarmAttached()).toBe(false);
		} finally {
			// Same teardown as the ipc suite's `afterEach`: drop the connections,
			// then close without awaiting the callback — a still-open peer socket
			// makes `close(cb)` wait out the whole test budget.
			(
				silent as net.Server & { closeAllConnections?: () => void }
			).closeAllConnections?.();
			silent.close();
		}
	});
});

// Recurrences prevented (#4353, #4376 review r1):
//  - the stale-endpoint unlink named the untruncated path, so under a long
//    TMPDIR it missed the stale file and `listen` failed EADDRINUSE;
//  - from TMPDIR 66 the pid was cut out of the pid-scoped name, so a second
//    session in one workspace bound the first session's name; once the unlink
//    reached the bound file it silently replaced the live listener (F1);
//  - the unlink could delete an unrelated regular file at the truncated name
//    (F2);
//  - Node refuses a path past `sun_path` with EINVAL rather than cutting it, so
//    both this fixture and the listener must name the BOUND file (#4376 r2).
// Session A is a stub listener on another pid's endpoint; session B is the real
// `configureWarmAttach` of this process.
describe.skipIf(process.platform === "win32")(
	"configureWarmAttach endpoint ownership under a long TMPDIR (#4376)",
	() => {
		const OTHER_PID = 4_194_303;
		const MIN_T = 75;

		async function withLongTmp(
			body: (ctx: { cwd: string; longTmp: string }) => Promise<void>,
		): Promise<void> {
			const { tmpDir } = setupTestEnvironment("pi-lens-wa-");
			// Pad to 75 characters (more if the root is longer): the pid-scoped
			// name then crosses sun_path, and the pad stays inside the root so
			// the cut lands in the FILE name.
			const pad = MIN_T - tmpDir.length - 1;
			const longTmp = pad >= 1 ? path.join(tmpDir, "p".repeat(pad)) : tmpDir;
			fs.mkdirSync(longTmp, { recursive: true });
			const cwd = path.join(tmpDir, "ws");
			fs.mkdirSync(cwd, { recursive: true });
			vi.stubEnv("TMPDIR", longTmp);
			vi.stubEnv("PI_LENS_WARM_ATTACH", "1");
			try {
				await body({ cwd, longTmp });
			} finally {
				_resetWarmAttachForTests();
				vi.unstubAllEnvs();
			}
		}

		/** Does B's pid survive the cut, so B's bound name is its own? */
		function ownNameSurvives(cwd: string): boolean {
			return boundUnixSocketPath(
				diagnosticsIpcPathForCwd(cwd, process.pid),
			).includes(`pi-lens-mcp-${process.pid}-`);
		}

		/**
		 * The name `net` actually binds or dials: the `sun_path`-bounded one. Node
		 * refuses a longer path with EINVAL rather than cutting it (#4376), so a
		 * case that hands `net` the untruncated spelling is testing the runtime's
		 * argument check, not this tree's name ownership. Every listener and every
		 * probe below therefore names the file the OS accepts.
		 */
		function boundEndpoint(cwd: string, pid: number): string {
			return boundUnixSocketPath(diagnosticsIpcPathForCwd(cwd, pid));
		}

		it("never replaces a live listener of another session in the workspace", async () => {
			await withLongTmp(async ({ cwd }) => {
				let reached = 0;
				const sessionA = net.createServer((socket) => {
					reached += 1;
					socket.end();
				});
				const derivedA = diagnosticsIpcPathForCwd(cwd, OTHER_PID);
				const endpointA = boundEndpoint(cwd, OTHER_PID);
				expect(endpointA, "the long root cut A's name").not.toBe(derivedA);
				expect(endpointA).toContain(`pi-lens-mcp-${OTHER_PID}-`);
				await new Promise<void>((resolve) =>
					sessionA.listen(endpointA, resolve),
				);
				try {
					await configureWarmAttach(cwd);
					expect(await connectOutcome(endpointA)).toBe("connected");
					expect(reached, "session A still owns its endpoint").toBe(1);
					// B runs its own fleet BESIDE A. Without this, a B that never
					// bound anything would satisfy the assertions above for the
					// wrong reason and the ownership rule would go unproven.
					expect(await connectOutcome(boundEndpoint(cwd, process.pid))).toBe(
						"connected",
					);
				} finally {
					(
						sessionA as net.Server & { closeAllConnections?: () => void }
					).closeAllConnections?.();
					sessionA.close();
				}
			});
		});

		it("clears a stale socket at its own bound name, and leaves a shared name alone", async () => {
			await withLongTmp(async ({ cwd }) => {
				const endpoint = diagnosticsIpcPathForCwd(cwd, process.pid);
				const bound = boundUnixSocketPath(endpoint);
				expect(bound, "the stale socket sits at a truncated name").not.toBe(
					endpoint,
				);
				await plantStaleUnixSocket(bound);
				await configureWarmAttach(cwd);
				// A pid inside the bound name makes the name B's own, so B clears the
				// stale socket and listens. Without it the name is shared, B cannot
				// tell whose socket it is, and it stays refused (cold fallback).
				expect(await connectOutcome(boundEndpoint(cwd, process.pid))).toBe(
					ownNameSurvives(cwd) ? "connected" : "ECONNREFUSED",
				);
			});
		});

		it("keeps an unrelated regular file at the bound name", async () => {
			await withLongTmp(async ({ cwd }) => {
				const endpoint = diagnosticsIpcPathForCwd(cwd, process.pid);
				const bound = boundUnixSocketPath(endpoint);
				fs.writeFileSync(bound, "user data");
				await configureWarmAttach(cwd);
				expect(fs.readFileSync(bound, "utf8")).toBe("user data");
				expect(await connectOutcome(boundEndpoint(cwd, process.pid))).not.toBe(
					"connected",
				);
			});
		});
	},
);

// Gentle Shell gives every child `pi` its own TMPDIR (`mkdtemp` under the
// inherited one, `lib/agents-runner.ts`), while the diagnostics endpoint used to
// be re-derived by the READER from its own `os.tmpdir()`. The child therefore
// computed a name under its own tmp root, reached nothing, and fell back to a
// local fleet. Each session now publishes the endpoint it BOUND in its
// instance-registry entry, and an attaching session connects to that.
describe.skipIf(process.platform === "win32")(
	"warm attach follows the incumbent's published endpoint",
	() => {
		/** This process's parent: a real live pid that is never `process.pid`. */
		const PEER_PID = process.ppid;
		const savedHome = process.env.PI_LENS_HOME;
		let tmpDir: string;
		let home: string;
		let root: string;
		/** The child's own tmp root: short enough for a socket name to fit. */
		let childTmp: string;
		let peer: net.Server | undefined;

		beforeEach(() => {
			tmpDir = setupTestEnvironment("pi-lens-wa-pub-").tmpDir;
			home = path.join(tmpDir, "home");
			root = path.join(tmpDir, "ws");
			fs.mkdirSync(home, { recursive: true });
			fs.mkdirSync(root, { recursive: true });
			childTmp = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-c-"));
			process.env.PI_LENS_HOME = home;
			vi.stubEnv("PI_LENS_WARM_ATTACH", "1");
			resetDegradationLedger();
		});

		afterEach(async () => {
			_resetWarmAttachForTests();
			await closeServer(peer);
			peer = undefined;
			resetDegradationLedger();
			vi.unstubAllEnvs();
			if (savedHome === undefined) delete process.env.PI_LENS_HOME;
			else process.env.PI_LENS_HOME = savedHome;
			removeTempDirSync(childTmp);
		});

		/** The name the incumbent BOUND, spelled as production publishes it. */
		function boundPeerEndpoint(): string {
			return boundUnixSocketPath(diagnosticsIpcPathForCwd(root, PEER_PID));
		}

		function writePeerEntry(diagnosticsEndpoint: string | undefined): void {
			fs.writeFileSync(
				path.join(home, "instances.json"),
				JSON.stringify({
					instances: [
						{
							...entry(PEER_PID, root, new Date().toISOString()),
							...(diagnosticsEndpoint === undefined
								? {}
								: { diagnosticsEndpoint }),
						},
					],
				}),
			);
		}

		/** A peer that answers one diagnostics request over the wire. */
		async function startPeer(endpoint: string): Promise<net.Server> {
			const server = net.createServer((socket) => {
				socket.setEncoding("utf8");
				let buffered = "";
				socket.on("data", (chunk: string) => {
					buffered += chunk;
					const newline = buffered.indexOf("\n");
					if (newline === -1) return;
					const request = JSON.parse(buffered.slice(0, newline)) as {
						contentHash: string;
					};
					socket.end(
						`${JSON.stringify({
							result: {
								route: "diagnostics",
								version: WARM_DIAGNOSTICS_SCHEMA_VERSION,
								diagnostics: [],
								contentHash: request.contentHash,
								servedAt: Date.now(),
								fresh: true,
								inconclusive: false,
								binding: { boundToCurrentDisk: "unknown" },
							},
						})}\n`,
					);
				});
			});
			await new Promise<void>((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpoint, resolve);
			});
			return server;
		}

		it("attaches over the published endpoint when the two sessions use different TMPDIRs", async () => {
			const published = boundPeerEndpoint();
			peer = await startPeer(published);
			vi.stubEnv("TMPDIR", childTmp);
			expect(diagnosticsIpcPathForCwd(root, PEER_PID)).not.toBe(published);
			writePeerEntry(published);

			await configureWarmAttach(root);
			expect(warmAttachAttachment()).toEqual({
				root,
				incumbentPid: PEER_PID,
				endpointPublished: true,
			});
			const result = await tryWarmAttachedDiagnostics("app.ts", "x", 1_000);
			expect(result?.available, JSON.stringify(result)).toBe(true);
			expect(isWarmAttached()).toBe(true);
		});

		it("attaches a Gentle Shell child to the parent's fleet when its TMPDIR is its own directory", async () => {
			const inheritedTmp = os.tmpdir();
			const published = boundPeerEndpoint();
			peer = await startPeer(published);
			// What Gentle Shell's runner does: one `mkdtemp` per child, UNDER the
			// inherited root, so the child's `os.tmpdir()` is not the parent's.
			vi.stubEnv("TMPDIR", childTmp);
			expect(path.dirname(childTmp)).toBe(inheritedTmp);
			expect(diagnosticsIpcPathForCwd(root, PEER_PID)).not.toBe(published);
			writePeerEntry(published);

			await configureWarmAttach(root);
			const result = await tryWarmAttachedDiagnostics("app.ts", "x", 1_000);
			expect(result?.available, JSON.stringify(result)).toBe(true);
			expect(warmAttachAttachment()?.incumbentPid).toBe(PEER_PID);
		});

		it("keeps deriving the endpoint for a peer that publishes nothing", async () => {
			const derived = diagnosticsIpcPathForCwd(root, PEER_PID);
			peer = await startPeer(derived);
			writePeerEntry(undefined);

			await configureWarmAttach(root);
			const result = await tryWarmAttachedDiagnostics("app.ts", "x", 1_000);
			expect(result?.available, JSON.stringify(result)).toBe(true);
			expect(isWarmAttached()).toBe(true);
		});

		it("ends local instead of attaching across TMPDIRs when the peer publishes nothing", async () => {
			vi.stubEnv("TMPDIR", childTmp);
			writePeerEntry(undefined);

			await configureWarmAttach(root);
			// Today's behavior for an older peer: it is still selected, and the
			// first request that reaches nothing promotes the session to local.
			expect(isWarmAttached()).toBe(true);
			const result = await tryWarmAttachedDiagnostics("app.ts", "x", 500);
			expect(result).toEqual({ available: false, reason: "no-listener" });
			expect(isWarmAttached(), "the child runs its own fleet").toBe(false);
		});

		it("promotes to local instead of hanging when the published endpoint no longer listens", async () => {
			writePeerEntry(
				path.join(
					tmpDir,
					"gone",
					"pi-lens-mcp-99-diagnostics-0123456789abcdef.sock",
				),
			);

			await configureWarmAttach(root);
			const result = await tryWarmAttachedDiagnostics("app.ts", "x", 5_000);
			expect(result).toEqual({ available: false, reason: "no-listener" });
			expect(isWarmAttached()).toBe(false);
		});

		it("publishes the name it bound, and registers only after reading peers", async () => {
			const published = boundPeerEndpoint();
			peer = await startPeer(published);
			writePeerEntry(published);

			await configureWarmAttach(root);
			expect(warmAttachAttachment()?.incumbentPid).toBe(PEER_PID);
			// Reading peers happens BEFORE this session writes its own entry.
			expect(
				(await readInstanceRegistry()).some(
					(candidate) => candidate.pid === process.pid,
				),
			).toBe(false);

			await registerInstance(root);
			const own = (await readInstanceRegistry()).find(
				(candidate) => candidate.pid === process.pid,
			);
			expect(own?.diagnosticsEndpoint).toBe(
				boundUnixSocketPath(diagnosticsIpcPathForCwd(root, process.pid)),
			);
			// The published name is the one this process really listens on.
			expect(await connectOutcome(own?.diagnosticsEndpoint ?? "")).toBe(
				"connected",
			);
		});
	},
);
