/**
 * The one parser for vendor/steammessages_clientnotificationtypes.proto.
 *
 * Three tools read the proto (gen-proto, gen-types-table, proto-sync) and each
 * used to carry its own regexes with its own miss behaviour -- proto-sync's
 * yielded empty sets on a structural change, which made the drift detector
 * print "no change", the reassuring branch, exactly when upstream had changed
 * shape. One parser, and a structural miss throws in all three.
 */

/**
 * @param {string} text  the .proto source
 * @returns {{ types: Array<{name: string, index: number}>,
 *             messages: Record<string, Record<number, {name: string, type: string}>> }}
 * @throws when the enum block is missing or matches no values
 */
export function parseProto(text) {
	const enumBody = /enum EClientNotificationType \{([\s\S]*?)\n\}/.exec(text);
	if (!enumBody) {
		throw new Error('EClientNotificationType enum not found -- the proto changed shape; re-read it');
	}

	const types = [...enumBody[1].matchAll(/k_EClientNotificationType_(\w+)\s*=\s*(\d+)/g)]
		.map(([, name, index]) => ({ name, index: Number(index) }))
		.sort((a, b) => a.index - b.index);
	if (types.length === 0) {
		throw new Error('EClientNotificationType matched no values -- the proto changed shape; re-read it');
	}

	const messages = {};
	for (const [, name, body] of text.matchAll(/message (\w+) \{([\s\S]*?)\n\}/g)) {
		const fields = {};
		for (const [, , type, field, num] of body.matchAll(
			/(optional|required|repeated)\s+([\w.]+)\s+(\w+)\s*=\s*(\d+)/g,
		)) {
			fields[Number(num)] = { name: field, type };
		}
		if (Object.keys(fields).length) messages[name] = fields;
	}

	return { types, messages };
}
