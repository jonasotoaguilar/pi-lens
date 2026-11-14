/**
 * T3 (S4) reachability, on the INITIALIZED production service.
 *
 * The sibling `pi-lens-data-root-decline.test.ts` drives `ClientRegistry`
 * directly, which skips the two gates a real dispatch passes first: the
 * session-root registry (`fileIsOutsideRegisteredRoots`) and the root ceiling.
 * This file asks the question the policy needs answered instead: with a
 * session initialized the way `session_start` initializes one, does a file
 * under pi-lens' own storage reach the spawn attempt at all?
 *
 * What it establishes, and what it does NOT:
 *
 *  1. REACHABLE. With the session root CONTAINING the store (`$HOME` holding
 *     `~/.pi-lens`), the file is inside a served root, the root resolves inside
 *     the store, and the baseline spawned there. The measurement is the spawn
 *     DOUBLE being called with the storage directory as its cwd — an attempted
 *     launch at that root — not an observed process; the fleet cwd T2a saw in
 *     the field was NOT reproduced (its evidence says so), so this reproduces
 *     the MECHANISM, not that field incident.
 *  2. NOT REACHABLE. With the store outside every served root the earlier gate
 *     declines the file before any root policy runs: no spawn, no
 *     `lsp-root-declined` record. Out-of-session data files are ordinary and
 *     quiet, which is why the guard below is scoped to what the session serves.
 *  3. NO OVER-REFUSAL. A `PILENS_DATA_DIR` that names the project itself (or an
 *     ancestor of it) is not a boundary: the owner's contract is `<base>/<slug>`
 *     per project, so the base can contain the project's own sources. A
 *     legitimate project root must still spawn.
 *  4. THE WORKTREE BOUNDARY. A linked worktree holding its own `.pi-lens` store
 *     roots at the worktree's `.git`, never inside the store, so the legacy arm
 *     needs no per-worktree project root.
 *  5. REDACTION. The reason folds the home prefix on the path's IDENTITY, so a
 *     `$HOME` spelled through a link does not print the account's real path.
 *     The record's SUBJECT keeps the existing `serverId:root` identity policy.
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
	initLSPConfig,
	resetLSPConfigStateForTests,
	_setServersForFileForTests,
} from "../../../clients/lsp/config.js";
import { LSPService } from "../../../clients/lsp/index.js";
import { BashServer, type LSPServerInfo } from "../../../clients/lsp/server.js";
import { isUnderDir } from "../../../clients/path-utils.js";
import { removeTempDirSync } from "../test-utils.js";

/** The production bash row with only the launched binary stubbed. */
function withStubSpawn(): LSPServerInfo & { spawn: ReturnType<typeof vi.fn> } {
	return {
		...BashServer,
		spawn: vi.fn(async () => undefined),
	} as LSPServerInfo & { spawn: ReturnType<typeof vi.fn> };
}

const tempDirs: string[] = [];

beforeEach(() => {
	resetLSPConfigStateForTests();
	resetDegradationLedger();
});

afterEach(() => {
	resetLSPConfigStateForTests();
	for (const dir of tempDirs.splice(0)) removeTempDirSync(dir);
	vi.unstubAllEnvs();
	resetDegradationLedger();
});

function tree(slug: string): string {
	const root = fs.realpathSync(
		fs.mkdtempSync(path.join(os.tmpdir(), `pi-lens-reach-${slug}-`)),
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

function declineRecord(): { count: number; reason: string; subject: string } {
	const group = getDegradationSummary().find(
		(entry) => entry.kind === "lsp-root-declined",
	);
	const latest = group?.latestReasons[0];
	return {
		count: group?.count ?? 0,
		reason: latest?.reason ?? "",
		subject: latest?.subject ?? "",
	};
}

/** One dispatch of `file` through the initialized production service. */
async function dispatch(
	sessionRoot: string,
	file: string,
	server: LSPServerInfo & { spawn: ReturnType<typeof vi.fn> },
): Promise<{ resolvedRoot: string | undefined }> {
	_setServersForFileForTests(() => [server]);
	await initLSPConfig(sessionRoot);
	const service = new LSPService(undefined, sessionRoot);
	// The registry is private to the service; the sibling root-policy suites read
	// it through the same structural cast, so the resolution the service uses is
	// the one asserted here.
	const resolvedRoot = await (
		service as unknown as {
			clientRegistry: {
				resolveServerRoot(
					server: LSPServerInfo,
					filePath: string,
				): Promise<string | undefined>;
			};
		}
	).clientRegistry.resolveServerRoot(server, file);
	await service.getClientForFile(file, 0);
	return { resolvedRoot };
}

describe("a dispatch of a pi-lens storage file, on the initialized service", () => {
	it("reaches the root policy when the session root contains the store", async () => {
		const home = tree("served-home");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", "");
		const file = plant(home, ".pi-lens", "projects", "demo", "cache", "x.sh");
		const server = withStubSpawn();

		const { resolvedRoot } = await dispatch(home, file, server);

		// The session root serves the file, and the resolved root is the store —
		// the baseline launched the server there (the mutation run in the
		// evidence shows exactly that call).
		expect(resolvedRoot).toBeDefined();
		expect(
			isUnderDir(resolvedRoot as string, path.join(home, ".pi-lens")),
		).toBe(true);
		expect(server.spawn).not.toHaveBeenCalled();
		const declined = declineRecord();
		expect(declined.count).toBe(1);
		expect(declined.reason).toContain("root inside pi-lens machine state dir");
	});

	it("is declined by the session-root gate when the store is outside every served root", async () => {
		const home = tree("unserved-home");
		const elsewhere = tree("unserved-root");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", "");
		const file = plant(home, ".pi-lens", "projects", "demo", "cache", "x.sh");
		const server = withStubSpawn();

		const { resolvedRoot } = await dispatch(elsewhere, file, server);

		// The earlier gate answers first, so an ordinary out-of-session data file
		// never reaches the root policy and leaves no decline record.
		expect(resolvedRoot).toBeUndefined();
		expect(server.spawn).not.toHaveBeenCalled();
		expect(declineRecord().count).toBe(0);
	});

	it("still spawns for a project that PILENS_DATA_DIR names as the store base", async () => {
		const home = tree("data-dir-is-project");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", path.join(home, ".state"));
		const project = path.join(home, "proj");
		fs.mkdirSync(project, { recursive: true });
		fs.writeFileSync(path.join(project, "package.json"), "{}\n");
		// The owner's contract is `<base>/<slug>` per project, so a base that
		// names the project itself still stores under it, not AT it.
		vi.stubEnv("PILENS_DATA_DIR", project);
		const file = plant(project, "src", "loose.sh");
		const server = withStubSpawn();

		const { resolvedRoot } = await dispatch(project, file, server);

		expect(resolvedRoot).toBe(project);
		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(server.spawn.mock.calls[0]?.[0]).toBe(project);
		expect(declineRecord().count).toBe(0);
	});

	it("roots a linked worktree at its own .git, never inside its .pi-lens store", async () => {
		const home = tree("worktree");
		vi.stubEnv("HOME", home);
		vi.stubEnv("USERPROFILE", home);
		vi.stubEnv("PI_LENS_HOME", path.join(home, ".state"));
		const worktree = path.join(home, "wt");
		fs.mkdirSync(worktree, { recursive: true });
		fs.writeFileSync(path.join(worktree, ".git"), "gitdir: /tmp/x\n");
		const file = plant(worktree, ".pi-lens", "cache", "y.sh");
		const server = withStubSpawn();

		const { resolvedRoot } = await dispatch(worktree, file, server);

		expect(resolvedRoot).toBe(worktree);
		expect(server.spawn).toHaveBeenCalledTimes(1);
		expect(server.spawn.mock.calls[0]?.[0]).toBe(worktree);
		expect(declineRecord().count).toBe(0);
	});

	it("folds the reason's path through a $HOME spelled as a symlink", async () => {
		const linkParent = tree("symlink-home");
		const realHome = path.join(linkParent, "real-home");
		fs.mkdirSync(realHome, { recursive: true });
		const homeLink = path.join(linkParent, "home-link");
		fs.symlinkSync(realHome, homeLink, "dir");
		vi.stubEnv("HOME", homeLink);
		vi.stubEnv("USERPROFILE", homeLink);
		vi.stubEnv("PI_LENS_HOME", "");
		// The file and its session root use the REAL spelling; `$HOME` is the
		// link. A spelling-only fold would print the account's real path here.
		const file = plant(
			realHome,
			".pi-lens",
			"projects",
			"demo",
			"cache",
			"z.sh",
		);
		const server = withStubSpawn();

		await dispatch(realHome, file, server);

		expect(server.spawn).not.toHaveBeenCalled();
		const declined = declineRecord();
		expect(declined.count).toBe(1);
		expect(declined.reason).toContain(
			"root inside pi-lens machine state dir (",
		);
		expect(declined.reason).toContain("~/.pi-lens/projects/demo/cache");
		expect(declined.reason).not.toContain(realHome);
	});
});
