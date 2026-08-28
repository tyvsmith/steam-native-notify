#!/usr/bin/env node
/**
 * Keep vendor/steammessages_clientnotificationtypes.proto honest.
 *
 * The definitions are vendored rather than depended on. The only npm package
 * that ships them (steam-protobuf) has two downloads a week, bundles 454 files,
 * and distributes generated JavaScript rather than the .proto, which is a poor
 * trade for a 9KB text file that can be read in full. Fetching at build time
 * instead would make builds non-reproducible and break them whenever GitHub is
 * unreachable.
 *
 * The real risk with vendoring is silent drift: Steam adds notification types
 * and nothing tells you. So drift is made visible instead.
 *
 *   npm run proto:check    compare against upstream, non-zero exit on drift
 *   npm run proto:update   pull upstream, record provenance, regenerate
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED = join(root, 'vendor', 'steammessages_clientnotificationtypes.proto');
const PROVENANCE = join(root, 'vendor', 'PROVENANCE.json');

const OWNER = 'SteamDatabase';
const REPO = 'SteamTracking';
const PATH = 'Protobufs/steammessages_clientnotificationtypes.proto';

async function fetchUpstream() {
	const meta = await fetch(
		`https://api.github.com/repos/${OWNER}/${REPO}/contents/${PATH}`,
		{ headers: { Accept: 'application/vnd.github+json' } },
	);
	if (!meta.ok) throw new Error(`GitHub returned ${meta.status} for the proto`);
	const body = await meta.json();

	const commits = await fetch(
		`https://api.github.com/repos/${OWNER}/${REPO}/commits?path=${encodeURIComponent(PATH)}&per_page=1`,
	);
	const [head] = commits.ok ? await commits.json() : [];

	return {
		text: Buffer.from(body.content, 'base64').toString('utf8'),
		blobSha: body.sha,
		commit: head?.sha ?? null,
		committedAt: head?.commit?.committer?.date ?? null,
	};
}

/** Enum values and message names, which is what actually matters downstream. */
function surface(text) {
	const enumBody = /enum EClientNotificationType \{([\s\S]*?)\n\}/.exec(text);
	return {
		types: new Set(
			[...(enumBody?.[1] ?? '').matchAll(/k_EClientNotificationType_(\w+)/g)].map((m) => m[1]),
		),
		messages: new Set([...text.matchAll(/^message (\w+)/gm)].map((m) => m[1])),
	};
}

function difference(a, b) {
	return [...b].filter((x) => !a.has(x));
}

const mode = process.argv[2] ?? '--check';
const local = readFileSync(VENDORED, 'utf8');
const upstream = await fetchUpstream();

if (local === upstream.text) {
	console.log(`proto is current (upstream commit ${upstream.commit?.slice(0, 8) ?? 'unknown'})`);
	process.exit(0);
}

const before = surface(local);
const after = surface(upstream.text);
const addedTypes = difference(before.types, after.types);
const removedTypes = difference(after.types, before.types);
const addedMessages = difference(before.messages, after.messages);

console.log('proto has drifted from upstream:');
console.log(`  upstream commit ${upstream.commit?.slice(0, 8) ?? '?'} (${upstream.committedAt ?? '?'})`);
if (addedTypes.length) console.log(`  new types:      ${addedTypes.join(', ')}`);
if (removedTypes.length) console.log(`  removed types:  ${removedTypes.join(', ')}`);
if (addedMessages.length) console.log(`  new messages:   ${addedMessages.join(', ')}`);
if (!addedTypes.length && !removedTypes.length && !addedMessages.length) {
	console.log('  no change to types or messages; comments or fields moved');
}

if (mode !== '--update') {
	console.log('\nrun `npm run proto:update` to take it');
	process.exit(1);
}

writeFileSync(VENDORED, upstream.text);
writeFileSync(
	PROVENANCE,
	JSON.stringify(
		{
			source: `https://github.com/${OWNER}/${REPO}/blob/master/${PATH}`,
			commit: upstream.commit,
			blob: upstream.blobSha,
			committedAt: upstream.committedAt,
			vendoredAt: new Date().toISOString(),
		},
		null,
		'\t',
	) + '\n',
);
console.log('\nvendored. run `npm run gen` to regenerate, then rebuild.');
