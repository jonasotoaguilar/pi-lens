/**
 * #475/#713: the worker's shared setup deletes the whole subagent vocabulary
 * before any case runs, so a lane that inherits a marker (every Gentle Shell
 * child sets `GENTLE_PI_AGENTS_CHILD=1`) cannot decide for a case whether
 * light or full behavior runs. That deletion is invisible from inside a test:
 * a case only sees its ABSENCE, which is also what a worker with no inherited
 * marker sees. This file is the witness that the deletion ran at all.
 *
 * Read-only by construction — it never writes `process.env`, so it adds no
 * write to the #4589 env-restore sweep and needs no baseline row.
 */

import { describe, expect, it } from "vitest";
import { SUBAGENT_VOCABULARY_KEYS } from "../../clients/subagent-mode.js";
import { SUBAGENT_VOCABULARY_KEYS as SETUP_KEYS } from "./vitest-setup.js";

describe("worker subagent vocabulary (#475/#713)", () => {
	it("deletes the owner's own key list, not a hand-copied one", () => {
		// Identity, not equality: the setup must IMPORT the list from
		// `clients/subagent-mode.ts`, so a fourth vocabulary is deleted here
		// without a second edit. A re-authored copy of the same keys would still
		// satisfy a set comparison and would still drift on the next addition.
		expect(SETUP_KEYS).toBe(SUBAGENT_VOCABULARY_KEYS);
	});

	it("leaves no vocabulary key set in this worker's environment", () => {
		const present = SUBAGENT_VOCABULARY_KEYS.filter(
			(key) => process.env[key] !== undefined,
		);
		expect(
			present,
			"an inherited subagent marker reached the test worker: the shared setup's deletion did not run",
		).toEqual([]);
	});
});
