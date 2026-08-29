import { callable } from 'millennium';

/**
 * Settings live in the backend; Lua's millennium.config does the persisting.
 * The frontend never learns where they are stored.
 */
const loadSettingsRaw = callable<[], string>('LoadSettings');
const saveSettingsRaw = callable<[{ payload: string }], string>('SaveSettings');

export interface Settings {
	/** Close Steam's own toast once its text has been read. */
	hideSteamToast: boolean;
	/**
	 * Leave overlay-context toasts alone: while a game has focus, Steam's own
	 * in-game toast stays as-is and no desktop notification is sent (nor is
	 * the toast closed, whatever hideSteamToast says). Desktop-context toasts
	 * are unaffected.
	 */
	nativeToastInGame: boolean;
	/**
	 * Accept commands from tools/fire (devfire.ts). A name-and-args door into
	 * Steam's notification stores for anything that can write the command file
	 * in the plugin's cache directory, so it ships off.
	 */
	devFire: boolean;
}

const DEFAULTS: Settings = { hideSteamToast: false, nativeToastInGame: false, devFire: false };

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
