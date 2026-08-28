import { callable } from '@steambrew/client';

/**
 * Settings live in the backend because this SDK build does not export
 * pluginConfig to the frontend; Lua's millennium.config does the persisting.
 */
const loadSettingsRaw = callable<[], string>('LoadSettings');
const saveSettingsRaw = callable<[{ payload: string }], string>('SaveSettings');

export interface Settings {
	/** Close Steam's own toast once its text has been read. */
	hideSteamToast: boolean;
	/**
	 * Accept commands from tools/fire (devfire.ts). A name-and-args door into
	 * Steam's notification stores for anything that can write the plugin
	 * directory, so it ships off.
	 */
	devFire: boolean;
}

const DEFAULTS: Settings = { hideSteamToast: false, devFire: false };

/**
 * Read by the toast handler on every notification, so the toggle takes effect
 * immediately rather than at the next Steam start.
 */
let current: Settings = { ...DEFAULTS };

export function settings(): Settings {
	return current;
}

/**
 * A callable's return value arrives JSON-encoded, so a Lua string comes back
 * wrapped in literal quote characters and needs unwrapping before it parses as
 * the object it represents.
 */
export function parseCallableJson<T>(raw: unknown, fallback: T): T {
	if (typeof raw !== 'string') return (raw as T) ?? fallback;
	try {
		const once = JSON.parse(raw);
		if (typeof once === 'string') return JSON.parse(once) as T;
		return once as T;
	} catch {
		return fallback;
	}
}

export async function loadSettings(): Promise<Settings> {
	try {
		current = { ...DEFAULTS, ...parseCallableJson<Partial<Settings>>(await loadSettingsRaw(), {}) };
	} catch {
		current = { ...DEFAULTS };
	}
	return current;
}

export async function updateSettings(patch: Partial<Settings>): Promise<Settings> {
	current = { ...current, ...patch };
	try {
		await saveSettingsRaw({ payload: JSON.stringify(current) });
	} catch {
		/* The value is already live; persistence can fail without breaking it. */
	}
	return current;
}
