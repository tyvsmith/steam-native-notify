import { ffi } from 'millennium';

/**
 * Diagnostics for the whole frontend, kept out of index so any module can log
 * without importing the capture path.
 *
 * These lines are the plugin's observability: tools/capture greps the plugin
 * log for the prefixes `hook installed`, `helper`, `from-toast `,
 * `toast <name> -> `, `dev-fire`, `replay: candidates`, `replay: invoke` and
 * `click-bridge`. Renaming a prefix without updating tools/capture blinds
 * the triage tool.
 */
const logLine = ffi<[string], string>('Log');

/** Never throws: diagnostics must not take the notification path down. */
export function dlog(line: string): void {
	try {
		void logLine(line);
	} catch {
		/* the log is best-effort by design */
	}
}

/**
 * JSON.stringify throws outright on a BigInt, and Steam's decoded values can be
 * any protobuf scalar. A debug line that throws killed every notification once
 * already, so serialising for logs is done defensively.
 */
export function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)) ?? 'undefined';
	} catch (e) {
		return `<unserialisable: ${(e as Error)?.message ?? e}>`;
	}
}
