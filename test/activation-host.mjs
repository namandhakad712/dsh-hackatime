// Host-half activation: apply() must settle with only the core `settings`
// service present and no `connection` (resolved lazily). Confirms the RPC
// registration can never block activation.
//
// The config handed to apply() is resolved through the REAL schemastery from
// the web profile, exactly as cordis does it — so `.volatile()` fields arrive
// as cosmokit references (`{ get, [write] }`) rather than plain values. That
// is the shape the previous release got wrong: `config.apiKey?.trim()` threw
// and killed the plugin at activation.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "lib", "index.js");
const src = fs.readFileSync(file, "utf8");

// The real schema library, loaded from the web profile so the volatile
// reference behaviour matches production byte for byte.
const profileNodeModules = "C:/Users/naman/.dsh/profiles/web/node_modules";
const schemaUrl = url.pathToFileURL(path.join(profileNodeModules, "@deepseek-ai", "schemastery", "lib", "index.mjs")).href;
const Schema = await import(schemaUrl).then((m) => m.default ?? m);

// schemastery's builder is chained heavily (.object(...).default(...).hidden()
// ...), so a Proxy that returns itself for any get/apply stands in for it.
// `match` is only ever called on real host config, never reached here.
const schemaChain = new Proxy(function () {}, {
	get: () => schemaChain,
	apply: () => schemaChain,
});

// Strip the ESM peer imports and export keywords so the module evaluates as a
// plain function body under node, without the profile's node_modules.
const stripped = src
	.replace(/^import\s+[^;]*;?\s*$/gm, "")
	.replace(/export\s+const\s+(\w+)/g, "__exports.$1 = $1")
	.replace(/export\s+function\s+apply/g, "__exports.apply = function apply")
	.replace(/export\s*\{[^}]*\}/g, "");

const body = `
const Schema = schemaChain;
const path = { join: () => "", dirname: () => "", basename: () => "" };
const os = { hostname: () => "test-host" };
const fs = {};
let __exports = {};
${stripped}
return __exports;
`;

let modExports;
try {
	modExports = new Function("schemaChain", body)(schemaChain);
} catch (error) {
	console.log("FAIL: module did not parse ->", error.message);
	process.exit(1);
}

console.log("host name:", modExports.name);
console.log("host inject:", JSON.stringify(modExports.inject));
if (modExports.inject.includes("connection")) {
	console.log("FAIL: connection must not be a hard inject");
	process.exit(1);
}

// The config cordis hands apply(): the plugin's own Config schema resolved
// over an empty override. Every `.volatile()` field is a reference object.
// Rebuilt here with the real Schema (lib/index.js's copy is stubbed above)
// so the shape matches production byte for byte.
const Config = Schema.object({
	enabled: Schema.boolean().default(true).volatile(),
	apiKey: Schema.string().role("secret").default("").volatile(),
	apiUrl: Schema.string().default("").volatile(),
	project: Schema.string().default("").volatile(),
	machine: Schema.string().default("").volatile(),
	rateLimitSeconds: Schema.number().default(30).min(5).max(600).volatile(),
	sendEntityPath: Schema.boolean().default(true).volatile(),
	sendAiUsage: Schema.boolean().default(true).volatile(),
	debug: Schema.boolean().default(false).volatile(),
	autoUpdate: Schema.boolean().default(true).volatile(),
});
// Resolve over a production-shaped override: everything volatile (so the
// reference shape is exercised) except autoUpdate, which the test profile
// turns off to avoid the real 90s self-update timer holding the process open.
const liveConfig = Config({ autoUpdate: false });
const probe = liveConfig.apiKey;
const isVolatileRef = probe !== null && typeof probe === "object" && typeof probe.get === "function";
console.log("config apiKey is a volatile reference:", isVolatileRef);
if (!isVolatileRef) {
	console.log("FAIL: Config schema did not resolve apiKey to a volatile reference — test no longer models production");
	process.exit(1);
}
// schemastery's volatile branch ALWAYS wraps the result in a reference — even
// when the caller supplies the value — so autoUpdate stays a ref carrying false.
// apply()'s unwrapVolatile is what turns it back into a plain boolean; without
// it the auto-update block would run on a truthy object and never disarm.
const autoUpdateRaw = liveConfig.autoUpdate;
const autoUpdatePlain = autoUpdateRaw !== null && typeof autoUpdateRaw === "object" && typeof autoUpdateRaw.get === "function" ? autoUpdateRaw.get() : autoUpdateRaw;
console.log("autoUpdate override still a ref, unwraps to:", autoUpdatePlain);
if (autoUpdatePlain !== false) {
	console.log("FAIL: autoUpdate=false override did not survive volatile resolution");
	process.exit(1);
}

// apply() with `settings` present and `connection` absent: the RPC registration
// is lazy (it injects ["settings","connection"]), so nothing may throw and
// activation must settle.
const fakeCtx = {
	inject: (services, fn) => {
		if (services.every((s) => fakeCtx[s] !== undefined)) return fn(fakeCtx);
		return () => {};
	},
	effect: (fn) => { fn(); return () => {}; },
	on: () => () => {},
	logger: { info() {}, warn() {}, error() {} },
	settings: { register: () => {}, describe: () => [], update: async () => {}, mutate: async () => {} },
};

try {
	modExports.apply(fakeCtx, liveConfig);
} catch (error) {
	console.log("FAIL: apply() threw ->", error.message);
	process.exit(1);
}

console.log("PASS: host half activates with settings only; connection stays lazy");

// --- the 0.1.7 regression -----------------------------------------------

// dsh >= 0.1.7 (#677) derives namespaces from a plugin's Config schema and
// deleted `register` from the settings service. Calling it anyway throws a
// TypeError cordis swallows — which killed the whole inject callback before
// `rpc.handle` ran, so the settings card saw no status and no config. This is
// the exact condition the user's empty page was in.
const noRegisterCtx = {
	inject: (services, fn) => {
		if (services.every((s) => noRegisterCtx[s] !== undefined)) return fn(noRegisterCtx);
		return () => {};
	},
	effect: (fn) => { fn(); return () => {}; },
	on: () => () => {},
	logger: { info() {}, warn() {}, error() {} },
	// No `register` key at all — Object.hasOwn is false, typeof is undefined.
	settings: { describe: () => [], update: async () => {}, mutate: async () => {} },
	connection: {
		rpc: {
			handle: (channel, handler) => {
				noRegisterCtx.__capturedChannel = channel;
				noRegisterCtx.__capturedHandler = handler;
				return () => {};
			},
		},
	},
};

try {
	modExports.apply(noRegisterCtx, liveConfig);
} catch (error) {
	console.log("FAIL: apply() threw on a register-less settings service ->", error.message);
	process.exit(1);
}

if (noRegisterCtx.__capturedChannel !== "/dsh-hackatime" || typeof noRegisterCtx.__capturedHandler !== "function") {
	console.log("FAIL: rpc.handle never ran — the settings card would be dead");
	process.exit(1);
}

// The handler must still serve endpoints without register having been called.
const res = await noRegisterCtx.__capturedHandler("hackatime.status", {});
if (!res?.ok || typeof res?.value?.enabled !== "boolean") {
	console.log("FAIL: status endpoint dead on a register-less host");
	process.exit(1);
}
if (res.value.session?.project !== null) {
	console.log("FAIL: live-session view should start empty");
	process.exit(1);
}

console.log("PASS: RPC registers and serves on a register-less (dsh >= 0.1.7) settings service");
