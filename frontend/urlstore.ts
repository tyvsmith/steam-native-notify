/**
 * Steam's named-URL table, fetched the way Steam's own CURLStore fetches it:
 * `SteamClient.URL.GetSteamURLList(names)` returns `{ name: { url, feature } }`
 * where the url is a template with `%p1%`-style parameters. Resolving here at
 * capture time keeps every base URL and template Steam's own data instead of a
 * hardcoded guess. See docs/steam-routing.md, "The URL store".
 */

/** Every name the routing catalog needs. Kept small; the client knows ~130. */
const URL_NAMES = [
	'CommunityFrontPage',
	'StoreFrontPage',
	'HelpFrontPage',
	'PendingGift',
	'SteamIDAchievementsPage',
] as const;

type UrlName = (typeof URL_NAMES)[number];

let templates: Partial<Record<UrlName, string>> = {};

/** Load the templates once. Resolves to a printable summary for the debug log. */
export async function loadUrlTemplates(): Promise<string> {
	try {
		const sc: any = Reflect.get(globalThis, 'SteamClient');
		const list = await sc?.URL?.GetSteamURLList?.([...URL_NAMES]);
		if (!list || typeof list !== 'object') return 'GetSteamURLList returned nothing';

		templates = {};
		for (const name of URL_NAMES) {
			const url = list[name]?.url;
			if (typeof url === 'string' && url) templates[name] = url;
		}
		return Object.entries(templates)
			.map(([k, v]) => `${k}=${v}`)
			.join(' ');
	} catch (e) {
		return `GetSteamURLList failed: ${(e as Error)?.message ?? e}`;
	}
}

/**
 * CURLStore.ResolveURL's substitution, verbatim: `%p1%` takes the first
 * parameter and so on. Returns null when the template never arrived, so a
 * caller routes nothing rather than emitting a broken URL.
 */
export function resolveUrl(name: UrlName, ...params: Array<string | number>): string | null {
	const template = templates[name];
	if (!template) return null;
	return template.replace(/%p(\d+)%/g, (match, index) => {
		const value = params[Number(index) - 1];
		return value === undefined ? match : String(value);
	});
}
