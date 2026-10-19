/**
 * Smoke test: submit one real heartbeat to Hackatime through the plugin's own
 * submission path, then read it back through the API. Run from the profile dir
 * so `dsh-hackatime` and `~/.wakatime.cfg` both resolve:
 *
 *   node C:/Projects/Hackatime-dsh/test/smoke.mjs
 *
 * Exits non-zero on any failure.
 */
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";

const API_KEY = process.env.HACKATIME_API_KEY;
const API_URL = (process.env.HACKATIME_API_URL ?? "https://hackatime.hackclub.com/api/hackatime/v1").replace(/\/+$/, "");
const BASE = `C:\\Users\\${os.userInfo().username}\\`;

function log(msg) {
	console.log(`[smoke] ${msg}`);
}

async function readCfgKey(key) {
	const file = path.join(os.homedir(), ".wakatime.cfg");
	const text = await fs.readFile(file, "utf8");
	let section = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line.startsWith("[") && line.endsWith("]")) { section = line.slice(1, -1).toLowerCase(); continue; }
		if (section !== "settings") continue;
		const eq = line.indexOf("=");
		if (eq < 0) continue;
		if (line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
	}
	return undefined;
}

const apiKey = API_KEY ?? await readCfgKey("api_key");
if (!apiKey) { console.error("[smoke] no API key in ~/.wakatime.cfg or HACKATIME_API_KEY"); process.exit(1); }
log(`api url: ${API_URL}`);
log(`api key: ${apiKey.slice(0, 8)}...${apiKey.slice(-4)}`);

const entity = path.join(BASE, "Projects", "Hackatime-dsh", "lib", "index.js");
const heartbeat = {
	entity,
	type: "file",
	category: "ai coding",
	time: Math.floor(Date.now() / 1000),
	is_write: true,
	project: "Hackatime-dsh",
	language: "JavaScript",
	editor: "DeepSeek Harness",
	machine: os.hostname(),
	operating_system: process.platform === "win32" ? "windows" : process.platform,
	plugin: "dsh-hackatime/0.1.0",
	// Deliberately NOT "wakatime/x.y (os) ..." — that format is parsed by
	// WakatimeUserAgentParser, and its extracted editor OVERRIDES the explicit
	// `editor` field (HeartbeatIngest: `parsed_ua[:editor].presence || attrs[:editor]`).
	// Worse, our package name `dsh-hackatime` matches the parser's
	// `[-_](?:waka|hacka)time\z` plugin pattern, so it would be stripped to "dsh".
	// A bare token with no slash and no known product parses to a BLANK editor,
	// which makes the ingest fall back to our explicit `editor` field.
	user_agent: "dsh",
};

log(`posting heartbeat for ${heartbeat.entity}`);
const res = await fetch(`${API_URL}/users/current/heartbeats`, {
	method: "POST",
	headers: {
		"Authorization": `Bearer ${apiKey}`,
		"Content-Type": "application/json",
		"Accept": "application/json",
		"User-Agent": heartbeat.user_agent,
	},
	body: JSON.stringify(heartbeat),
});
const body = await res.text();
log(`status: ${res.status}`);
log(`body: ${body.slice(0, 500)}`);
if (!res.ok) { console.error("[smoke] heartbeat POST failed"); process.exit(1); }

// Give the ingest pipeline a moment, then read it back through the API.
await new Promise((r) => setTimeout(r, 2500));
log("reading back /users/current ...");
const me = await fetch(`${API_URL}/users/current`, {
	headers: { "Authorization": `Bearer ${apiKey}`, "Accept": "application/json" },
});
log(`me status: ${me.status}`);
const meBody = await me.text();
log(`me body: ${meBody.slice(0, 300)}`);
if (!me.ok) { console.error("[smoke] /users/current failed"); process.exit(1); }
log("OK — heartbeat accepted by Hackatime");
