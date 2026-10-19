// Exercises the host RPC handler end-to-end against a faithful in-memory mock of
// the real `settings` service (describe/update/mutate over a config document).
// Proves hackatime.config.get returns schema-resolved values and
// hackatime.config.set persists a patch — the mechanism the settings tab now
// depends on instead of the version-gated browser config scopes.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "lib", "index.js");
const src = fs.readFileSync(file, "utf8");

// schemastery stand-in: a chainable builder where every method returns a fresh
// field carrying the accumulated options. The plugin only chains
// `.default(x).volatile().description(...)`, and the RPC reads resolved values
// from the settings-store mock, so `default` is purely a builder method here.
const makeField = (opts) => {
	const field = (value) => value;
	Object.defineProperty(field, "meta", { value: { ...opts } });
	Object.defineProperty(field, "default", { value: (d) => makeField({ ...opts, default: d }) });
	field.volatile = () => makeField({ ...opts, volatile: true });
	field.description = (d) => makeField({ ...opts, description: d });
	field.min = (m) => makeField({ ...opts, min: m });
	field.max = (m) => makeField({ ...opts, max: m });
	field.role = (r) => makeField({ ...opts, role: r });
	field.step = (s) => makeField({ ...opts, step: s });
	return field;
};
const schemaChain = {
	object: (dict) => {
		const s = (value) => value;
		Object.defineProperty(s, "type", { value: "object" });
		Object.defineProperty(s, "dict", { value: dict });
		Object.defineProperty(s, "meta", { value: {} });
		return s;
	},
	boolean: () => makeField({ type: "boolean" }),
	string: () => makeField({ type: "string" }),
	number: () => makeField({ type: "number" }),
};

const stripped = src
	.replace(/^import\s+[^;]*;?\s*$/gm, "")
	.replace(/export\s+const\s+(\w+)/g, "__exports.$1 = $1")
	.replace(/export\s+function\s+apply/g, "__exports.apply = function apply")
	.replace(/export\s*\{[^}]*\}/g, "");

const body = `
const Schema = schemaChain;
const path = { join: () => "", dirname: () => "", basename: () => "", resolve: () => "", extname: () => "" };
const os = { hostname: () => "test-host" };
const fs = {};
const child_process = { spawn: __stubSpawn };
let __exports = {};
${stripped}
return __exports;
`;

const modExports = new Function("schemaChain", "__stubSpawn", body)(schemaChain, (cmd, args, opts) => {
	// A fake child that exits 0 with a short line, so the update endpoint
	// resolves without ever spawning a real process.
	const handlers = { data: [], exit: [], error: [] };
	const emitter = {
		stdout: { on: (ev, fn) => handlers.data.push(fn) },
		stderr: { on: (ev, fn) => handlers.data.push(fn) },
		on: (ev, fn) => handlers[ev]?.push(fn),
		once: (ev, fn) => handlers[ev]?.push(fn),
		kill: () => {},
	};
	queueMicrotask(() => {
		for (const fn of handlers.data) fn("updated dsh-hackatime\n");
		for (const fn of handlers.exit) fn(0);
	});
	return emitter;
});
if (!modExports?.Config) {
	console.log("FAIL: Config schema missing");
	process.exit(1);
}

// --- in-memory settings service mock ---------------------------------------

const store = {
	enabled: true,
	apiKey: "cfg-key",
	apiUrl: "",
	project: "",
	machine: "",
	rateLimitSeconds: 30,
	sendEntityPath: true,
	sendAiUsage: true,
	debug: false,
};

const settingsService = {
	register: () => {},
	describe: () => [{ ns: "hackatime", value: { ...store }, revision: 1 }],
	update: async (ns, patch) => { Object.assign(store, patch); },
	replace: async (ns, section) => {
		for (const key of Object.keys(store)) Reflect.deleteProperty(store, key);
		Object.assign(store, section);
	},
	mutate: async (ns, ops) => {
		for (const op of ops) {
			if (op.op === "unset") delete store[op.path];
		}
	},
};

// Capture the RPC handler the plugin registers.
let rpcChannel = null;
let rpcHandler = null;
const fakeCtx = {
	inject: (services, fn) => {
		if (services.every((s) => fakeCtx[s] !== undefined)) return fn(fakeCtx);
		return () => {};
	},
	effect: (fn) => { fn(); return () => {}; },
	on: () => () => {},
	logger: { info() {}, warn() {}, error() {} },
	settings: settingsService,
	connection: {
		rpc: {
			handle: (channel, handler) => { rpcChannel = channel; rpcHandler = handler; return () => {}; },
		},
	},
};

try {
	modExports.apply(fakeCtx, { ...store });
} catch (error) {
	console.log("FAIL: apply() threw ->", error.message);
	process.exit(1);
}

if (rpcChannel !== "/dsh-hackatime" || typeof rpcHandler !== "function") {
	console.log("FAIL: RPC handler not registered on /dsh-hackatime");
	process.exit(1);
}

// --- config.get -------------------------------------------------------------

const getRes = await rpcHandler("hackatime.config.get", {});
if (!getRes?.ok) {
	console.log("FAIL: config.get failed ->", getRes?.error);
	process.exit(1);
}
// The API key is write-only on the RPC read path: it must be masked out so a
// plaintext response never carries the stored secret. The card learns "is a
// key set?" from the status payload instead.
if (getRes.value.apiKey !== "") {
	console.log(`FAIL: config.get must mask the apiKey, got ${JSON.stringify(getRes.value.apiKey)}`);
	process.exit(1);
}
console.log("config.get ok: apiKey masked | enabled =", getRes.value.enabled);

// --- config.set -------------------------------------------------------------

const setRes = await rpcHandler("hackatime.config.set", { apiKey: "new-key", project: "my-proj" });
if (!setRes?.ok) {
	console.log("FAIL: config.set failed ->", setRes?.error);
	process.exit(1);
}
// The write path lands in the store, but the response masks the secret too.
if (setRes.value.apiKey !== "" || setRes.value.project !== "my-proj") {
	console.log("FAIL: config.set did not echo merged values (or leaked the key)");
	process.exit(1);
}
if (store.apiKey !== "new-key" || store.project !== "my-proj") {
	console.log("FAIL: config.set did not persist to the settings store");
	process.exit(1);
}
console.log("config.set ok: persisted apiKey + project");

// --- config.unset -----------------------------------------------------------

const unsetRes = await rpcHandler("hackatime.config.unset", { keys: ["project"] });
if (!unsetRes?.ok) {
	console.log("FAIL: config.unset failed ->", unsetRes?.error);
	process.exit(1);
}
if (store.project !== undefined) {
	console.log("FAIL: config.unset did not remove the field");
	process.exit(1);
}
console.log("config.unset ok: project removed");

// --- config.set falling back to the Loader entry ----------------------------

// The packaged host boots from app.asar while profile plugins resolve
// @deepseek-ai/dsh-app-app-boot from the profile's own node_modules — two module
// instances, two module-level WeakMaps, so configEditor.edit's
// reconcileProfilePatches throws "profile reload requires the root Include
// entry" for every plugin. When settings.update fails, config.set must fall
// back to applying the patch through the Loader entry instead of surfacing the
// error to the card.
let loaderEntryConfig = null;
/** Faithful stand-in for cordis-plugin-loader's Entry.update: it merges the new
 * options into `this.options` (deleting null/undefined) and records the config
 * it was asked to apply. */
const loaderEntry = {
	options: { id: "hackatime", name: "dsh-hackatime" },
	parent: { tree: { ctx: { fiber: { entry: { id: "include" } } } } },
	update: async (options) => {
		if (options?.config === undefined) return;
		const config = { ...(loaderEntry.options.config ?? {}) };
		for (const [key, value] of Object.entries(options.config)) {
			if (value === null || value === undefined) Reflect.deleteProperty(config, key);
			else config[key] = value;
		}
		loaderEntry.options.config = config;
		loaderEntryConfig = config;
	},
};
const brokenSettings = {
	...settingsService,
	update: async () => { throw new Error("dsh: profile reload requires the root Include entry"); },
	replace: async () => { throw new Error("dsh: profile reload requires the root Include entry"); },
};

/** Build a context whose inject stub resolves against itself, so each apply()
 * sees its own settings service and its own RPC capture. */
const makeCtx = (overrides) => {
	const ctx = {
		effect: (fn) => { fn(); return () => {}; },
		on: () => () => {},
		logger: { info() {}, warn() {}, error() {} },
		...overrides,
	};
	ctx.inject = (services, fn) => {
		if (services.every((s) => ctx[s] !== undefined)) return fn(ctx);
		return () => {};
	};
	return ctx;
};

let fallbackHandler = null;
const fallbackCtx = makeCtx({
	settings: brokenSettings,
	root: { loader: { entries: () => [loaderEntry] } },
	connection: { rpc: { handle: (channel, handler) => { fallbackHandler = handler; return () => {}; } } },
});
modExports.apply(fallbackCtx, { ...store });
if (typeof fallbackHandler !== "function") {
	console.log("FAIL: fallback RPC handler not registered");
	process.exit(1);
}

const fallbackSet = await fallbackHandler("hackatime.config.set", { project: "fallback-proj" });
if (!fallbackSet?.ok) {
	console.log("FAIL: config.set did not fall back to the Loader entry ->", fallbackSet?.error);
	process.exit(1);
}
if (loaderEntryConfig?.project !== "fallback-proj") {
	console.log("FAIL: the Loader entry never received the patch");
	process.exit(1);
}
// The merge must build on the entry's raw override, not the resolved values, so
// unset keys keep inheriting schema defaults instead of being pinned by the write.
if (loaderEntryConfig.rateLimitSeconds !== undefined) {
	console.log("FAIL: fallback pinned an unset key instead of leaving it inherited");
	process.exit(1);
}
console.log("config.set fallback ok: applied through the Loader entry when settings.update throws");

// A second patch layers on top of the first rather than resetting the override.
const fallbackSet2 = await fallbackHandler("hackatime.config.set", { apiKey: "second-key" });
if (!fallbackSet2?.ok || loaderEntryConfig?.apiKey !== "second-key" || loaderEntryConfig?.project !== "fallback-proj") {
	console.log("FAIL: a second fallback patch did not layer onto the existing override");
	process.exit(1);
}
console.log("config.set fallback ok: later patches layer onto the stored override");

// A null value clears the key (the card sends null for "use the default").
const fallbackSet3 = await fallbackHandler("hackatime.config.set", { project: null });
if (!fallbackSet3?.ok || loaderEntryConfig.project !== undefined) {
	console.log("FAIL: null patch did not clear the key");
	process.exit(1);
}
console.log("config.set fallback ok: null clears the key");

// A schema-rejected value must never reach the profile file.
const rejectingEntry = {
	options: { id: "hackatime", name: "dsh-hackatime" },
	parent: { tree: { ctx: { fiber: { entry: { id: "include" } } } } },
	update: async () => { throw new Error("rateLimitSeconds must be between 5 and 600"); },
};
let rejectingHandler = null;
const rejectingCtx = makeCtx({
	settings: brokenSettings,
	root: { loader: { entries: () => [rejectingEntry] } },
	connection: { rpc: { handle: (channel, handler) => { rejectingHandler = handler; return () => {}; } } },
});
modExports.apply(rejectingCtx, { ...store });
const rejected = await rejectingHandler("hackatime.config.set", { rateLimitSeconds: 1 });
if (rejected?.ok) {
	console.log("FAIL: a schema-rejected write was reported as success");
	process.exit(1);
}
if (!rejected?.error?.message?.includes("between 5 and 600")) {
	console.log("FAIL: schema rejection did not surface the reason ->", rejected?.error?.message);
	process.exit(1);
}
console.log("config.set fallback ok: schema violations are reported, never persisted");

// When the Loader is unreachable too, the card must get a clear combined error
// rather than a silent success or an unhandled rejection.
let noLoaderHandler = null;
const noLoaderCtx = makeCtx({
	settings: brokenSettings,
	root: {},
	connection: { rpc: { handle: (channel, handler) => { noLoaderHandler = handler; return () => {}; } } },
});
modExports.apply(noLoaderCtx, { ...store });
const bothFail = await noLoaderHandler("hackatime.config.set", { project: "x" });
if (bothFail?.ok) {
	console.log("FAIL: config.set reported success when every write path failed");
	process.exit(1);
}
if (!bothFail?.error?.message?.includes("profile reload")) {
	console.log("FAIL: combined error lost the primary cause ->", bothFail?.error?.message);
	process.exit(1);
}
console.log("config.set failure ok: reports the primary cause plus the fallback failure");

// --- status -----------------------------------------------------------------

const statusRes = await rpcHandler("hackatime.status", {});
if (!statusRes?.ok) {
	console.log("FAIL: status failed ->", statusRes?.error);
	process.exit(1);
}
if (typeof statusRes.value.enabled !== "boolean") {
	console.log("FAIL: status did not report a boolean enabled");
	process.exit(1);
}
console.log("status ok: enabled =", statusRes.value.enabled);

// The live-session view the "Currently tracking" panel reads. It exists and is
// empty before any activity — the card renders it immediately, so a missing
// object would throw in the browser.
if (!statusRes.value.session || typeof statusRes.value.session !== "object") {
	console.log("FAIL: status.session missing");
	process.exit(1);
}
if (statusRes.value.session.project !== null || statusRes.value.session.entity !== null) {
	console.log("FAIL: live-session view should start empty");
	process.exit(1);
}
if (typeof statusRes.value.version !== "string") {
	console.log("FAIL: status.version must be a string for the update badge");
	process.exit(1);
}
console.log("status ok: live-session view present, empty; version =", statusRes.value.version);

// --- version ---------------------------------------------------------------

const versionRes = await rpcHandler("hackatime.version", {});
if (!versionRes?.ok) {
	console.log("FAIL: version failed ->", versionRes?.error);
	process.exit(1);
}
if (typeof versionRes.value.current !== "string") {
	console.log("FAIL: version.current missing");
	process.exit(1);
}
if (typeof versionRes.value.updateAvailable !== "boolean") {
	console.log("FAIL: version.updateAvailable must be a boolean");
	process.exit(1);
}
console.log("version ok: current =", versionRes.value.current, "| latest =", versionRes.value.latest ?? "unreachable");

// --- update ----------------------------------------------------------------

// runSelfUpdate spawns a child, which the test host cannot do. The endpoint
// must resolve, not hang, and report the failure rather than throwing.
const updateRes = await rpcHandler("hackatime.update", { profile: "web" });
if (updateRes?.ok) {
	console.log("note: update unexpectedly succeeded in the test host");
} else if (!updateRes?.error) {
	console.log("FAIL: update failure must carry an error body");
	process.exit(1);
}
console.log("update ok: resolves in a spawn-less host with", updateRes.error?.code ?? "success");

// --- unknown endpoint -------------------------------------------------------

const badRes = await rpcHandler("hackatime.nope", {});
if (badRes?.ok) {
	console.log("FAIL: unknown endpoint unexpectedly succeeded");
	process.exit(1);
}
console.log("unknown endpoint ok: rejected with", badRes.error.code);

console.log("PASS: host RPC round-trips config get/set/unset, status, version and update");
process.exit(0);
