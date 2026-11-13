/**
 * #1500 round 3 — what an install attempt DID, read from the installer itself.
 *
 * The first version of this evidence inferred attempt-ness from
 * `getInstallFailureReason`, and a review proved that inverts the answer in both
 * directions: that map is written by the `PI_LENS_DISABLE_TOOL_INSTALL` branches
 * and the install-lock skip, and by NOTHING on the genuine-failure or success
 * paths. So a policy decline read as a failed download, and every real download
 * failure — the retry candidate this evidence exists to surface — read as a
 * policy decision. The old tests passed because they mocked the reason map and
 * pinned the mapping's assumption rather than the installer's behavior.
 *
 * These drive the REAL installer: only the spawn layer is mocked, `PI_LENS_HOME`
 * points at a temp dir so the managed tools directory is disposable, and each
 * case exercises the branch that records the outcome.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { describeInstallAttempt } from "../../clients/dispatch/runners/utils/availability-policy.js";
import { withEnv } from "../support/with-env.js";
import { waitFor } from "./interleaving-kit.js";

const { safeSpawnAsync, logLatencySpy } = vi.hoisted(() => ({
	safeSpawnAsync: vi.fn(),
	logLatencySpy: vi.fn(),
}));

vi.mock("../../clients/latency-logger.js", async (importOriginal) => ({
	...(await importOriginal()),
	logLatency: logLatencySpy,
	getLastLoggedPhase: () => undefined,
}));

vi.mock("../../clients/safe-spawn.js", () => ({
	safeSpawnAsync,
	safeSpawn: vi.fn(() => ({ stdout: "", stderr: "", status: 1 })),
	resetSafeSpawnWindowsCommandCache: vi.fn(),
	isCommandAvailableAsync: vi.fn(async () => false),
}));

let piLensHome: string;
let restoreEnv: () => void;

/** The real installer, loaded fresh so `TOOLS_DIR` picks up `PI_LENS_HOME`. */
async function installer(): Promise<
	typeof import("../../clients/installer/index.js")
> {
	vi.resetModules();
	return import("../../clients/installer/index.js");
}

const npmOk = { stdout: "", stderr: "", status: 0 };
const npmFailed = {
	stdout: "",
	stderr: "npm error 404 Not Found - GET https://registry.npmjs.org/fish-lsp",
	status: 1,
};

/** Plant the binary an npm install is expected to leave behind. */
function plantFishLspBinary(): void {
	const binDir = path.join(piLensHome, "tools", "node_modules", ".bin");
	fs.mkdirSync(binDir, { recursive: true });
	const isWin = process.platform === "win32";
	for (const name of isWin
		? ["fish-lsp.cmd", "fish-lsp.exe", "fish-lsp"]
		: ["fish-lsp"]) {
		fs.writeFileSync(path.join(binDir, name), "#!/bin/sh\nexit 0\n", {
			mode: 0o755,
		});
	}
}

/** The evidence on the last availability_decision row, whatever emitted it. */
function lastInstallEvidence(): Record<string, unknown> | undefined {
	const rows = logLatencySpy.mock.calls
		.map((call) => call[0])
		.filter((entry) => entry?.phase === "availability_decision");
	return rows[rows.length - 1]?.metadata?.evidence;
}

beforeEach(() => {
	safeSpawnAsync.mockReset();
	logLatencySpy.mockReset();
	piLensHome = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-lens-install-attempt-"),
	);
	// Every case here rests on the premise that none of these tools is installed:
	// the discovery rung resolves nothing, so the install half actually runs and
	// records. A host with `fish-lsp` (or any other managed tool) on PATH broke
	// that premise — `getToolPath` answered from PATH, no install ran, and the
	// attempt row these cases read was simply absent. Pin PATH to an empty
	// directory inside the disposable home so only what a case plants is
	// discoverable, on this host and on CI.
	const emptyPathDir = path.join(piLensHome, "empty-path");
	fs.mkdirSync(emptyPathDir, { recursive: true });
	restoreEnv = withEnv({
		PI_LENS_HOME: piLensHome,
		PI_LENS_DISABLE_TOOL_INSTALL: undefined,
		PATH: emptyPathDir,
	});
});

afterEach(async () => {
	// The trust state is process-wide; reset it in teardown so a failed
	// assertion cannot leak "untrusted" into the next file's case.
	(await import("../../clients/project-trust.js")).resetProjectTrust();
	restoreEnv();
	fs.rmSync(piLensHome, { recursive: true, force: true });
});

describe("the installer records what its attempt did (#1500)", () => {
	it("a kill-switch decline is not an attempt", async () => {
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallAttempt } = await installer();

		expect(await ensureTool("fish-lsp")).toBeUndefined();
		const attempt = getInstallAttempt("fish-lsp");
		expect(attempt?.outcome).toBe("declined");
		expect(describeInstallAttempt(attempt)).toMatchObject({
			install: "not-attempted",
			installReason: expect.stringContaining("PI_LENS_DISABLE_TOOL_INSTALL"),
		});
	});

	it("a caller that forbids installing is not an attempt either", async () => {
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallAttempt } = await installer();

		expect(
			await ensureTool("fish-lsp", { allowInstall: false }),
		).toBeUndefined();
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("declined");
		expect(describeInstallAttempt(getInstallAttempt("fish-lsp")).install).toBe(
			"not-attempted",
		);
	});

	it("a genuine install failure IS an attempt, with the installer's reason", async () => {
		// The npm install runs and fails. THIS is the retry candidate, and the
		// pre-round mapping reported it as `not-attempted`.
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallAttempt } = await installer();

		expect(await ensureTool("fish-lsp")).toBeUndefined();
		const attempt = getInstallAttempt("fish-lsp");
		expect(attempt?.outcome).toBe("failed");
		expect(describeInstallAttempt(attempt)).toMatchObject({
			install: "failed",
		});
	});

	// #2638 review: a caller that needs to tell "the installer genuinely
	// failed" (E404, EBADENGINE, network error) from "declined"/"skipped"
	// needs the ACTUAL npm error text, not the generic "install failed"
	// fallback `finishInstallAttempt` uses when nothing set
	// `installFailureReasons` — the tool-smoke lane's classification
	// (`scripts/smoke-tools.mjs`'s `classifyInstallOutcome`) reads exactly
	// this (via `getInstallAttempt(...).reason`) to decide RED vs the
	// toolchain-absent ⚠ skip.
	it("a genuine npm install failure records the real registry error, not a generic fallback", async () => {
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallFailureReason, getInstallAttempt } =
			await installer();

		expect(await ensureTool("fish-lsp")).toBeUndefined();
		const reason = getInstallFailureReason("fish-lsp");
		expect(reason).toContain("404 Not Found");
		expect(reason).toContain("fish-lsp");
		expect(getInstallAttempt("fish-lsp")?.reason).toBe(reason);
	});

	// #2661 review F4: `installPipTool`'s own catch swallowed its error
	// byte-identically to `installNpmTool`'s pre-fix bug — every pip-strategy
	// tool (cmake-language-server, jedi-language-server, …) that genuinely
	// failed to install recorded the same generic fallback, indistinguishable
	// from a policy decline to any caller reading `getInstallAttempt`.
	it("a genuine pip install failure records the real pip error, not a generic fallback", async () => {
		safeSpawnAsync.mockImplementation(async (command: string) =>
			command === "pip3"
				? {
						stdout: "",
						stderr:
							"ERROR: Could not find a version that satisfies the requirement cmake-language-server\nsecond diagnostic line",
						status: 1,
					}
				: { stdout: "", stderr: "", status: 1, error: new Error("ENOENT") },
		);
		const { ensureTool, getInstallFailureReason, getInstallAttempt } =
			await installer();

		expect(await ensureTool("cmake-language-server")).toBeUndefined();
		const attempt = getInstallAttempt("cmake-language-server");
		expect(attempt?.outcome).toBe("failed");
		const reason = getInstallFailureReason("cmake-language-server") ?? "";
		expect(reason).toContain("cmake-language-server");
		expect(reason).toContain("pip3 install --user");
		expect(reason).not.toBe("install failed");
		expect(attempt?.reason).toBe(reason);
		expect(reason).toContain("ENOENT");
		expect(reason).not.toContain("\n");
		expect(reason.length).toBeLessThan(1000);
	});

	it("does not spawn an unavailable Python interpreter", async () => {
		const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-lens-no-python-"));
		fs.writeFileSync(path.join(binDir, "pip3"), "pip3", { mode: 0o755 });
		const calls: string[] = [];
		safeSpawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				calls.push(`${command} ${args.join(" ")}`);
				return { stdout: "", stderr: "no pip", status: 1 };
			},
		);
		const restorePath = withEnv({ PATH: binDir });
		try {
			const { ensureTool } = await installer();
			await ensureTool("cmake-language-server");
		} finally {
			restorePath();
			fs.rmSync(binDir, { recursive: true, force: true });
		}
		expect(calls.some((call) => call.startsWith("python3 -m venv "))).toBe(
			false,
		);
		expect(calls.some((call) => call.startsWith("python -m venv "))).toBe(
			false,
		);
	});

	it("preserves a PEP 668 pip refusal for downstream classification", async () => {
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "error: externally-managed-environment",
			status: 1,
		});
		const { ensureTool, getInstallAttempt } = await installer();
		expect(await ensureTool("cmake-language-server")).toBeUndefined();
		expect(getInstallAttempt("cmake-language-server")?.reason).toContain(
			"externally-managed-environment",
		);
	});

	it("a successful install records succeeded", async () => {
		safeSpawnAsync.mockImplementation(async () => {
			// The install "downloads" the package: plant what npm would leave.
			plantFishLspBinary();
			return npmOk;
		});
		const { ensureTool, getInstallAttempt } = await installer();

		const resolved = await ensureTool("fish-lsp");
		expect(resolved).toBeDefined();
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("succeeded");
		expect(describeInstallAttempt(getInstallAttempt("fish-lsp")).install).toBe(
			"succeeded",
		);
	});

	it("keeps the real attempt snapshot distinct from a later cached ensure", async () => {
		safeSpawnAsync.mockImplementation(async () => {
			plantFishLspBinary();
			return npmOk;
		});
		const { ensureTool, getInstallAttempt } = await installer();

		expect(await ensureTool("fish-lsp")).toBeDefined();
		const firstAttempt = getInstallAttempt("fish-lsp");
		expect(firstAttempt?.outcome).toBe("succeeded");

		// The second real ensure clears the process-global last-attempt slot before
		// returning its session-cache result. A caller that saved the first result
		// immediately after its await still reports the correct install.
		expect(await ensureTool("fish-lsp")).toBeDefined();
		expect(getInstallAttempt("fish-lsp")).toBeUndefined();
		expect(describeInstallAttempt(firstAttempt)).toMatchObject({
			install: "succeeded",
		});
	});

	it("project-trust denial records a decline, not a failure", async () => {
		safeSpawnAsync.mockResolvedValue(npmFailed);
		const { ensureTool, getInstallAttempt } = await installer();
		const trust = await import("../../clients/project-trust.js");
		trust.setProjectTrustState("untrusted");

		expect(await ensureTool("fish-lsp")).toBeUndefined();
		const attempt = getInstallAttempt("fish-lsp");
		expect(attempt?.outcome).toBe("declined");
		expect(describeInstallAttempt(attempt)).toMatchObject({
			install: "not-attempted",
			installReason: expect.stringContaining("project trust"),
		});
	});

	it("no attempt at all reads as not-attempted", async () => {
		const { getInstallAttempt } = await installer();
		expect(getInstallAttempt("fish-lsp")).toBeUndefined();
		expect(describeInstallAttempt(undefined)).toEqual({
			install: "not-attempted",
		});
	});
});

/**
 * The same two cases, end to end through a real `SecurityScanClient` and the real
 * installer, because that is where the inversion was VISIBLE: the row a user
 * would read in latency.log said the opposite of what happened, in both
 * directions.
 */
describe("the row a reader sees matches what the install did (#1500)", () => {
	async function probeAndInstall(): Promise<void> {
		vi.resetModules();
		const { SecurityScanClient } =
			await import("../../clients/security-scan-client.js");
		class FakeScanClient extends SecurityScanClient<string[]> {
			constructor() {
				// fish-lsp is a real npm-strategy tool id, so the installer takes its
				// genuine path rather than bailing on an unknown id.
				super("fish-lsp");
			}
			protected doEnsureAvailable(): Promise<boolean> {
				return this.ensureViaInstaller(["--version"]);
			}
		}
		expect(await new FakeScanClient().ensureAvailable()).toBe(false);
	}

	it("a kill-switch decline does not read as a failed install", async () => {
		process.env.PI_LENS_DISABLE_TOOL_INSTALL = "1";
		// The version probe misses, so the install path is entered and declined.
		safeSpawnAsync.mockResolvedValue({
			stdout: "",
			stderr: "",
			status: null,
			error: Object.assign(new Error("spawn fish-lsp ENOENT"), {
				code: "ENOENT",
			}),
			failure: "spawn",
			spawnFailure: { kind: "tool-not-found" },
		});

		await probeAndInstall();
		expect(lastInstallEvidence()).toMatchObject({ install: "not-attempted" });
	});

	it("a genuine install failure reads as a failed install", async () => {
		safeSpawnAsync.mockImplementation(async (_cmd: string, args: string[]) => {
			if (args.includes("--version")) {
				return {
					stdout: "",
					stderr: "",
					status: null,
					error: Object.assign(new Error("spawn fish-lsp ENOENT"), {
						code: "ENOENT",
					}),
					failure: "spawn",
					spawnFailure: { kind: "tool-not-found" },
				};
			}
			// The install itself runs and fails.
			return npmFailed;
		});

		await probeAndInstall();
		expect(lastInstallEvidence()).toMatchObject({ install: "failed" });
	});
});

/**
 * D5 (Gentle Shell audit): auto-install is serialized by ONE machine-global
 * install lock. A child that lost that race waited out its whole budget and then
 * spent the session without the tool — it recorded `skipped` without asking
 * again, even when the winner had already installed the binary.
 *
 * These cases hold the real legacy lock file with a live owner (no second
 * process, no network) and drive the waiter's bound through
 * `PI_LENS_INSTALL_LOCK_TIMEOUT_MS`, the lever `installer/install-lock.test.ts`
 * uses. The binary appears mid-wait, which is what a concurrent installer's
 * success looks like to this process.
 */
describe("the loser of the install-lock race (D5)", () => {
	/** The waiter's whole budget in these cases. */
	const LOCK_WAIT_MS = 200;
	const LEGACY_LOCK = (): string =>
		path.join(piLensHome, "tools", ".install.lock");
	let restoreLockEnv: () => void;
	let installCommands: string[];

	/** The probe answer for a tool that is not installed. */
	const notFound = { stdout: "", stderr: "", status: 1 };

	beforeEach(() => {
		restoreLockEnv = withEnv({
			PI_LENS_INSTALL_LOCK_TIMEOUT_MS: String(LOCK_WAIT_MS),
		});
		installCommands = [];
		// Another process holds the machine-global lock: a live owner and a fresh
		// file, which is exactly what `acquireInstallLock` reads.
		fs.mkdirSync(path.join(piLensHome, "tools"), { recursive: true });
		fs.writeFileSync(
			LEGACY_LOCK(),
			JSON.stringify({ pid: process.pid, createdAt: Date.now() }),
		);
	});

	afterEach(() => {
		restoreLockEnv();
		fs.rmSync(path.join(piLensHome, "tools", ".install.locks"), {
			recursive: true,
			force: true,
		});
	});

	it("takes the binary the winner installed instead of skipping the session", async () => {
		safeSpawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				if (args.includes("install")) {
					installCommands.push(`${command} ${args.join(" ")}`);
					return npmOk;
				}
				// Present only once the concurrent install has landed.
				const planted = fs.existsSync(
					path.join(piLensHome, "tools", "node_modules", ".bin", "fish-lsp"),
				);
				return planted ? npmOk : notFound;
			},
		);
		const { ensureTool, getInstallAttempt, getInstallFailureReason } =
			await installer();
		// The ledger the freshly imported installer writes to; importing it AFTER
		// `installer()` is what makes it that instance and not a stale pre-reset one.
		const { getDegradationSummary } =
			await import("../../clients/degradation-ledger.js");

		const pending = ensureTool("fish-lsp");
		// The winner's install completes while this process waits for the lock, and
		// the wait itself is the only event that can order the two: the lock
		// contention record (`generation-lock-legacy-held`, written once by the
		// first backing-off poll) proves the pre-lock resolution has finished, so
		// planting there lands the binary between the two resolutions. Planting
		// earlier would let the FIRST resolution find it and take the "already
		// available" path, which never reaches the re-ask this case pins. A raw
		// timer would make that ordering a wall-clock race instead of a premise.
		await waitFor(
			() =>
				getDegradationSummary().some(
					(group) => group.kind === "generation-lock-legacy-held",
				),
			(seen) => seen,
			{
				timeoutMs: 5_000,
				yieldControl: () => new Promise((resolve) => setImmediate(resolve)),
			},
		);
		plantFishLspBinary();
		const resolved = await pending;

		expect(getInstallAttempt("fish-lsp")).toMatchObject({
			outcome: "succeeded",
			reason: "installed by a concurrent process",
		});
		expect(resolved).toMatch(/fish-lsp(\.cmd|\.exe)?$/);
		expect(fs.existsSync(resolved as string)).toBe(true);
		// A winner's install is not this process's refusal.
		expect(getInstallFailureReason("fish-lsp")).toBeUndefined();
		// Losers take the winner's binary; none of them runs a package manager.
		expect(installCommands).toEqual([]);
	});

	it("still records the skip, with its reason, when the bounded wait expires with nothing to take", async () => {
		safeSpawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				if (args.includes("install")) {
					installCommands.push(`${command} ${args.join(" ")}`);
				}
				return notFound;
			},
		);
		const { ensureTool, getInstallAttempt } = await installer();

		expect(await ensureTool("fish-lsp")).toBeUndefined();
		const attempt = getInstallAttempt("fish-lsp");
		expect(attempt?.outcome).toBe("skipped");
		expect(attempt?.reason).toContain(
			`timed out after ${LOCK_WAIT_MS}ms waiting for shared tools install lock`,
		);
		expect(describeInstallAttempt(attempt)).toMatchObject({
			install: "not-attempted",
		});
		expect(installCommands).toEqual([]);
	});

	it("records a genuine install failure as failed, not skipped, once the lock frees", async () => {
		safeSpawnAsync.mockImplementation(
			async (command: string, args: string[]) => {
				if (!args.includes("install")) return notFound;
				installCommands.push(`${command} ${args.join(" ")}`);
				return npmFailed;
			},
		);
		const { ensureTool, getInstallAttempt } = await installer();

		// The peer holds the lock for this whole budget and installs nothing.
		expect(await ensureTool("fish-lsp")).toBeUndefined();
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("skipped");

		// The peer is gone. This process now runs its OWN install, which fails.
		fs.rmSync(LEGACY_LOCK(), { force: true });
		expect(await ensureTool("fish-lsp")).toBeUndefined();
		expect(getInstallAttempt("fish-lsp")?.outcome).toBe("failed");
	});
});
