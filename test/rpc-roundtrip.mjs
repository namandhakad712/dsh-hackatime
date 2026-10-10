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
let __exports = {};
${stripped}
return __exports;
`;

const modExports = new Function("schemaChain", body)(schemaChain);
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
if (getRes.value.apiKey !== "cfg-key") {
	console.log(`FAIL: config.get returned apiKey ${JSON.stringify(getRes.value.apiKey)}, expected "cfg-key"`);
	process.exit(1);
}
console.log("config.get ok: apiKey =", getRes.value.apiKey, "| enabled =", getRes.value.enabled);

// --- config.set -------------------------------------------------------------

const setRes = await rpcHandler("hackatime.config.set", { apiKey: "new-key", project: "my-proj" });
if (!setRes?.ok) {
	console.log("FAIL: config.set failed ->", setRes?.error);
	process.exit(1);
}
if (setRes.value.apiKey !== "new-key" || setRes.value.project !== "my-proj") {
	console.log("FAIL: config.set did not echo merged values");
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

// --- unknown endpoint -------------------------------------------------------

const badRes = await rpcHandler("hackatime.nope", {});
if (badRes?.ok) {
	console.log("FAIL: unknown endpoint unexpectedly succeeded");
	process.exit(1);
}
console.log("unknown endpoint ok: rejected with", badRes.error.code);

console.log("PASS: host RPC round-trips config get/set/unset and status");
