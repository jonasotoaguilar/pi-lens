/**
 * Which endpoint a client connects to for an incumbent's warm diagnostics.
 *
 * Every reader used to RE-DERIVE that endpoint from its own `os.tmpdir()`, so a
 * reader whose tmp root differs from the incumbent's — every Gentle Shell child,
 * whose runner gives each child `mkdtemp` under the inherited root — computed a
 * name the incumbent never bound. The incumbent now publishes the name it bound
 * in its instance-registry entry, and a reader uses that string AS IT STANDS:
 * the `sun_path` cut belongs to the bind, and a second cut here could only
 * disagree with the file that exists.
 */

import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
	boundUnixSocketPath,
	diagnosticsIpcPathForCwd,
	peerDiagnosticsEndpoint,
} from "../../clients/mcp/ipc.js";

const CWD = "/work/space";
const PID = 4_242;
const PUBLISHED_SOCKET =
	"/tmp/pi-lens-parent/pi-lens-mcp-99-diagnostics-0123456789abcdef.sock";
const PUBLISHED_PIPE =
	"\\\\.\\pipe\\pi-lens-mcp-99-diagnostics-0123456789abcdef";

describe("peerDiagnosticsEndpoint", () => {
	it("uses the endpoint the incumbent published, as it stands", () => {
		expect(peerDiagnosticsEndpoint(CWD, PID, PUBLISHED_SOCKET, "linux")).toBe(
			PUBLISHED_SOCKET,
		);
		// A published pipe name crosses the same way. The platform argument only
		// decides the shape of the FALLBACK, never the published value.
		expect(peerDiagnosticsEndpoint(CWD, PID, PUBLISHED_PIPE, "win32")).toBe(
			PUBLISHED_PIPE,
		);
		expect(peerDiagnosticsEndpoint(CWD, PID, PUBLISHED_SOCKET, "win32")).toBe(
			PUBLISHED_SOCKET,
		);
	});

	it("derives the endpoint for a peer that publishes nothing", () => {
		for (const platform of ["linux", "darwin", "win32"] as const) {
			expect(peerDiagnosticsEndpoint(CWD, PID, undefined, platform)).toBe(
				diagnosticsIpcPathForCwd(CWD, PID, platform),
			);
		}
		// An empty published value is a record with nothing to say, not a path.
		expect(peerDiagnosticsEndpoint(CWD, PID, "", "linux")).toBe(
			diagnosticsIpcPathForCwd(CWD, PID, "linux"),
		);
	});

	it("does not re-cut a published name the OS already truncated", () => {
		const long = path.join(
			"/tmp",
			"p".repeat(90),
			"pi-lens-mcp-4242-diagnostics-0123456789abcdef.sock",
		);
		const bound = boundUnixSocketPath(long, "linux");
		expect(Buffer.byteLength(bound), "the fixture crosses sun_path").toBe(108);
		expect(bound).not.toBe(long);
		// Verbatim: no second cut, and no re-spelling of the name.
		expect(peerDiagnosticsEndpoint(CWD, PID, bound, "linux")).toBe(bound);
	});
});
