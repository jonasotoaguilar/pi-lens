/**
 * T3 (S4) — an LSP root must never land inside pi-lens' own storage.
 *
 * `declinesLooseFileRoot` (#4760) refuses a root AT or ABOVE `$HOME` and
 * nothing else, while `RootWithFallback` hands an unrooted file to
 * `FileDirRoot`, which answers its nearest non-excluded ancestor. A file under
 * the extension's own data directories therefore resolves to that directory as
 * its root. T2a's field evidence did NOT reproduce a live fleet there (it
 * recorded zero such processes and said so); what it named was the mechanism,
 * and this file measures the mechanism: the machine state dir (`~/.pi-lens` or
 * a `PI_LENS_HOME` tree), the project data store (its `projects/` arm or
 * `PILENS_DATA_DIR`), and the legacy `<project>/.pi-lens`.
 *
 * Every cell drives the registry's acquisition seam and reads the observable
 * outcome: whether the launch was ATTEMPTED (the spawn double is called with a
 * root) and what the one bounded `lsp-root-declined` record said. A recorded
 * spawn call is an attempted launch at that root, not an observed process —
 * the process boundary is exactly what the double replaces. The root functions
 * and the registry are production, as in the sibling #4760 and #4806 files.
 *
 * REACHABILITY: a file outside every served session root never reaches this
 * seam — `pi-lens-data-root-decline` cases are reached through
 * `lsp-root-pi-lens-data-reachable.test.ts`, which drives the initialized
 * service and shows both the reachable shape (the session root contains the
 * store) and the earlier session-root gate that answers first otherwise.
 *
 * The trees are built under `os.tmpdir()` on purpose, not with
 * `pinFixtureHome`: fixture homes live under the checkout, whose `.git`
 * answers the root walk before any fallback, so the data-dir root could never
 * be reached there. A marker-less temp tree is what a real home outside a
 * checkout is (the same fixture shape the #4760 file uses).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	getDegradationSummary,
	resetDegradationLedger,
} from "../../../clients/degradation-ledger.js";
import {
	ClientRegistry,
	type ClientGenerationHooks,
	type LSPClientAcquisitionOutcome,
} from "../../../clients/lsp/client-registry.js";
import {
	MarksmanServer,
	OpengrepServer,
	type LSPServerInfo,
} from "../../../clients/lsp/server.js";
import { isUnderDir } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

function makeHooks(): ClientGenerationHooks {
	return {
		releaseNotifyWrite: () => undefined,
		forgetReadiness: () => undefined,
		forgetNotifyBacklog: () => undefined,
		clearStallDemotion: () => undefined,
		rearmFirstContact: () => undefined,
		noteDiagnosticsPublished: () => undefined,
	};
}

/**
 * A production server row with only the launched binary stubbed. The stub
 * reports the binary unavailable, so a call to it is the evidence that the
 * registry did not decline — and no client machinery runs.
 */
function withStubSpawn(server: LSPServerInfo): LSPServerInfo & {
	spawn: ReturnType<typeof vi.fn>;
} {
	return {
		...server,
		spawn: vi.fn(async () => undefined),
	} as LSPServerInfo & { spawn: ReturnType<typeof vi.fn> };
}

const tempDirs: string[] = [];

beforeEach(() => {
	resetDegradationLedger();
});

afterEach(() => {
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
	vi.unstubAllEnvs();
	resetDegradationLedger();
});

/** A marker-less tree outside the checkout (see the file header). */
function tree(slug: string): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-dataroot-${slug}-`)),
	);
	tempDirs.push(root);
	return root;
}

function plant(dir: string, ...segments: string[]): string {
	const file = path.join(dir, ...segments);
	fs.mkdirSync(path.dirname(file), { recursive: true });
	fs.writeFileSync(file, "#!/bin/sh\necho ok\n");
	return file;
}

interface Acquisition {
	resolvedRoot: string | undefined;
	outcomes: Array<LSPClientAcquisitionOutcome | undefined>;
}

async function acquire(
	sessionCwd: string,
	file: string,
	server: LSPServerInfo,
): Promise<Acquisition> {
	const registry = new ClientRegistry(makeHooks(), undefined, sessionCwd);
	const resolvedRoot = await registry.resolveServerRoot(server, file);
	const outcomes: Array<LSPClientAcquisitionOutcome | undefined> = [];
	await registry.ensureClientForServer(
		file,
		server,
		undefined,
		undefined,
		(value) => outcomes.push(value),
	);
	return { resolvedRoot, outcomes };
}

/** The one bounded decline record this file's cases assert on. */
function declineRecord(): { count: number; subject: string; reason: string } {
	const group = getDegradationSummary().find(
		(entry) => entry.kind === "lsp-root-declined",
	);
	const latest = group?.latestReasons[0];
	return {
		count: group?.count ?? 0,
		subject: latest?.subject ?? "",
		reason: latest?.reason ?? "",
	};
}

describe("an LSP root inside pi-lens' own data directories (T3/S4)", () => {
	it("declines a root inside the default machine state dir (~/.pi-lens)", async () => {
		const home = tree("machine-default");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		// The harness pins PI_LENS_HOME per worker; the default arm is what this
		// cell is about, so the override is cleared for its duration.
		vi.stubEnv("PI_LENS_HOME", "");
		const file = plant(home, ".pi-lens", "projects", "demo", "cache", "x.sh");
		const server = withStubSpawn(OpengrepServer);

		const { resolvedRoot } = await acquire(home, file, server);

		// The root the policy answered, before any spawn decision: pi-lens'
		// own storage (pre-fix this is where opengrep was launched).
		expect(resolvedRoot).toBeDefined();
		expect(
			isUnderDir(resolvedRoot as string, path.join(home, ".pi-lens")),
		).toBe(true);
		expect(server.spawn).not.toHaveBeenCalled();
		const declined = declineRecord();
		expect(declined.count).toBe(1);
		expect(declined.reason).toContain("machine state dir");
		expect(declined.reason).toContain("~/.pi-lens/projects/demo/cache");
	});

	it("declines a root inside a PI_LENS_HOME-relocated machine state dir", async () => {
		const home = tree("machine-override");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		const state = path.join(home, ".state");
		vi.stubEnv("PI_LENS_HOME", state);
		const file = plant(state, "projects", "demo", "cache", "y.sh");
		const server = withStubSpawn(OpengrepServer);

		const { resolvedRoot } = await acquire(home, file, server);

		expect(resolvedRoot).toBeDefined();
		expect(isUnderDir(resolvedRoot as string, state)).toBe(true);
		expect(server.spawn).not.toHaveBeenCalled();
		expect(declineRecord().reason).toContain("machine state dir");
	});

	it("declines a root inside a PILENS_DATA_DIR project data store", async () => {
		const home = tree("data-override");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", path.join(home, ".state"));
		const store = path.join(home, "lens-data");
		vi.stubEnv("PILENS_DATA_DIR", store);
		const file = plant(store, "demo-0123abcd", "cache", "z.sh");
		const server = withStubSpawn(OpengrepServer);

		const { resolvedRoot } = await acquire(home, file, server);

		expect(resolvedRoot).toBeDefined();
		expect(isUnderDir(resolvedRoot as string, store)).toBe(true);
		expect(server.spawn).not.toHaveBeenCalled();
		expect(declineRecord().reason).toContain("project data dir");
	});

	it("declines a root inside the legacy project-local .pi-lens store", async () => {
		const home = tree("data-legacy");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", path.join(home, ".state"));
		const project = path.join(home, "legacy");
		const file = plant(project, ".pi-lens", "cache", "w.sh");
		const server = withStubSpawn(OpengrepServer);

		const { resolvedRoot } = await acquire(project, file, server);

		expect(resolvedRoot).toBeDefined();
		expect(
			isUnderDir(resolvedRoot as string, path.join(project, ".pi-lens")),
		).toBe(true);
		expect(server.spawn).not.toHaveBeenCalled();
		expect(declineRecord().reason).toContain("project data dir");
	});

	// The refusal is a root-policy answer, not a loose-file one: marksman
	// declares no `looseFileRoot`, so `declinesLooseFileRoot` answers false for
	// every root it is given.
	it("declines it for a server that declares no loose-file root", async () => {
		const home = tree("marksman");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", "");
		const file = plant(home, ".pi-lens", "projects", "demo", "cache", "n.md");
		const server = withStubSpawn(MarksmanServer);

		const { resolvedRoot } = await acquire(home, file, server);

		expect(resolvedRoot).toBeDefined();
		expect(server.spawn).not.toHaveBeenCalled();
		expect(declineRecord().count).toBe(1);
	});

	it("still roots a deep directory below $HOME that is not pi-lens storage", async () => {
		const home = tree("legit-deep");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", path.join(home, ".state"));
		const project = path.join(home, "work", "app");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "package.json"), "{}\n");
		const file = plant(project, "src", "loose.sh");
		const server = withStubSpawn(OpengrepServer);

		const { resolvedRoot, outcomes } = await acquire(home, file, server);

		expect(resolvedRoot).toBe(project);
		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(server.spawn.mock.calls[0]?.[0]).toBe(project);
		expect(outcomes).toEqual(["spawn-failure"]);
		expect(declineRecord().count).toBe(0);
	});

	it("never catches the session root itself", async () => {
		const home = tree("session-root");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", path.join(home, ".state"));
		const sessionRoot = path.join(home, "work", "app");
		fs.mkdirSync(sessionRoot, { recursive: true });
		fs.writeFileSync(path.join(sessionRoot, ".git"), "gitdir: /tmp/x\n");
		const file = plant(sessionRoot, "src", "loose.sh");
		const server = withStubSpawn(OpengrepServer);

		const { resolvedRoot, outcomes } = await acquire(sessionRoot, file, server);

		expect(resolvedRoot).toBe(sessionRoot);
		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(server.spawn.mock.calls[0]?.[0]).toBe(sessionRoot);
		expect(declineRecord().count).toBe(0);
		expect(outcomes).toEqual(["spawn-failure"]);
	});

	// The realistic legacy shape: the project root HOLDS `<project>/.pi-lens`, so
	// the project is an ANCESTOR of a data directory. Containment is
	// descendant-only, so the project still roots while a file INSIDE its store
	// is declined (the cell above).
	it("still roots a project that holds a legacy data directory", async () => {
		const home = tree("legacy-ancestor");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", path.join(home, ".state"));
		const project = path.join(home, "proj");
		fs.mkdirSync(path.join(project, ".pi-lens"), { recursive: true });
		fs.writeFileSync(path.join(project, "package.json"), "{}\n");
		const file = plant(project, "src", "loose.sh");
		const server = withStubSpawn(OpengrepServer);

		const { resolvedRoot, outcomes } = await acquire(project, file, server);

		expect(resolvedRoot).toBe(project);
		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(server.spawn.mock.calls[0]?.[0]).toBe(project);
		expect(declineRecord().count).toBe(0);
		expect(outcomes).toEqual(["spawn-failure"]);
	});
});
