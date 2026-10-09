/**
 * Unit harness for the dsh-hackatime host half.
 *
 * Loads lib/index.js, calls apply() with a fake cordis ctx, feeds it synthetic
 * session events, and asserts that heartbeats reach a captured fetch without
 * crashing the host. Run from the profile dir:
 *
 *   node C:/Projects/Hackatime-dsh/test/harness.mjs
 */
import { pathToFileURL } from "node:url";
import path from "node:path";
import os from "node:os";

const PLUGIN_DIR = "C:/Projects/Hackatime-dsh";
const mod = await import(pathToFileURL(path.join(PLUGIN_DIR, "lib/index.js")).href);
console.log("loaded:", mod.name, "inject:", JSON.stringify(mod.inject));

let assertions = 0;
function check(cond, msg) {
	assertions++;
	if (!cond) { console.error(`FAIL: ${msg}`); process.exit(1); }
	console.log(`  ok: ${msg}`);
}

// --- fake cordis context -----------------------------------------------------
const posted = [];
const settingsRegistrations = [];
const effects = [];
const timers = [];

const fakeConfig = {
	enabled: true,
	apiKey: "test-key",
	apiUrl: "https://example.invalid/api",
	project: "test-project",
	machine: "test-machine",
	rateLimitSeconds: 30,
	sendEntityPath: true,
	sendAiUsage: true,
	debug: true,
};

globalThis.fetch = async (url, init) => {
	posted.push({ url: String(url), init });
	return new Response(JSON.stringify({ id: 1, accepted: true }), {
		status: 202, headers: { "content-type": "application/json" },
	});
};

const ctx = {
	logger: { warn: (...a) => console.log("  [warn]", ...a), info: (...a) => console.log("  [info]", ...a) },
	on: (event, cb) => { ctx._handlers ??= new Map(); const list = ctx._handlers.get(event) ?? []; list.push(cb); ctx._handlers.set(event, list); },
	emit: () => {},
	inject: (deps, cb) => {
		// dsh's ctx.inject runs the callback once services are available. The
		// plugin only injects ["settings"] to register its config schema.
		settingsRegistrations.push(deps);
		const sctx = {
			settings: {
				register: (name, schema, opts) => settingsRegistrations.push({ name, opts }),
			},
		};
		cb(sctx);
	},
	effect: (fn) => { effects.push(fn); },
	setTimeout: (fn, ms) => { timers.push({ fn, ms }); },
};

console.log("\n== apply() ==");
mod.apply(ctx, fakeConfig);
check(settingsRegistrations.some((r) => Array.isArray(r) && r[0] === "settings"), "injects the settings service");
check(typeof ctx._handlers?.get("session/event")?.[0] === "function", "subscribes to session/event");
check(effects.length >= 1, "registers a cleanup effect");

// --- feed events -------------------------------------------------------------
const now = Date.now();
const session = { header: { cwd: "C:/Projects/test-workspace" } };
const emit = (event) => ctx._handlers.get("session/event")[0](session, event);

console.log("\n== user/message ==");
emit({ type: "user/message", time: now, data: { content: "hello" } });

console.log("\n== tool/call write ==");
emit({
	type: "tool/call",
	time: now + 1000,
	data: { name: "write", callId: "c1", arguments: JSON.stringify({ file_path: "C:/Projects/test-workspace/src/main.js", content: "x" }) },
});

console.log("\n== tool/result ==");
emit({ type: "tool/result", time: now + 2000, data: { callId: "c1" } });

console.log("\n== assistant/message with usage ==");
emit({
	type: "assistant/message",
	time: now + 3000,
	data: { usage: { inputTokens: 100, outputTokens: 50 } },
});

// Let all async record()/flush() promises settle.
await new Promise((r) => setTimeout(r, 1500));

console.log(`\n== ${posted.length} heartbeat POST(s) captured ==`);
check(posted.length > 0, "at least one heartbeat was POSTed");
const first = posted[0];
check(first.url.endsWith("/users/current/heartbeats"), `POST url is the heartbeats endpoint: ${first.url}`);
check(first.init.headers.Authorization === "Bearer test-key", "Bearer auth header");
check(first.init.headers["Content-Type"] === "application/json", "JSON content type");
const body = JSON.parse(first.init.body);
console.log("  body:", JSON.stringify(body));
check(body.category === "coding", "category is coding");
check(body.editor === "DeepSeek Harness", "editor is DeepSeek Harness");
check(body.project === "test-project", "project name");
check(body.machine === "test-machine", "machine name");
check(body.time >= 1_000_000_000 && body.time < 2_000_000_000, "time is epoch seconds in the sane window");
check(typeof body.time === "number" && Number.isInteger(body.time), "time is an integer");
check(body.user_agent === "dsh", "user_agent is the bare token that yields a blank parse");
check(body.plugin.startsWith("dsh-hackatime/"), "plugin field");
check(!!body.entity, "entity present");

// Effect cleanup must not throw.
for (const fn of effects) { const r = fn(); if (r && r.then) await r; }
console.log("\nALL ASSERTIONS PASSED");
process.exit(0);
