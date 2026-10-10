// Proves the client half activates even when `settingsScope` is unavailable —
// the exact condition that crashed boot at 0.2.0 ("waiting for service:
// settingsScope"). Loads the real module factory the browser uses and drives
// apply() with a minimal host that provides NO settingsScope/configForms.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "lib", "client.js");
const src = fs.readFileSync(file, "utf8");

let captured;
const fakeRequire = (name) => {
	if (name === "react") return {
		createElement: () => null,
		useState: () => [{}, () => {}],
		useEffect: () => {},
		useSyncExternalStore: () => ({ value: {} }),
		useCallback: (fn) => fn,
	};
	throw new Error(`unexpected require: ${name}`);
};

// window.__ModuleLoader__.load({id, factory}) — the browser entry shape.
const moduleLoader = {
	load(entry) { captured = entry; },
};
globalThis.window = { __ModuleLoader__: moduleLoader };

// Execute the client bundle exactly as the browser would.
new Function("require", "window", src)(fakeRequire, globalThis.window);

console.log("loader id:", captured.id);

// The factory returns module.exports — invoke it the way the loader does.
const exports = captured.factory(fakeRequire);
console.log("exports.inject:", JSON.stringify(exports.inject));

// The property that crashed 0.2.0: settingsScope must NOT be a hard dependency.
if (exports.inject.includes("settingsScope")) {
	console.log("FAIL: settingsScope is a hard inject — boot would hang");
	process.exit(1);
}
if (exports.inject.includes("configForms")) {
	console.log("FAIL: configForms must stay lazy too");
	process.exit(1);
}

// A context with neither settings service, and no connection/rpc. The old code
// threw here; apply() must settle and register nothing harmful.
const registered = [];
const ctx = {
	slots: {
		inject: (name, fn) => {
			// Only seats that actually exist on this host get a registration.
			registered.push(name);
			return fn();
		},
		register: () => () => {},
	},
	inject: (services, fn) => {
		// Lazy resolution: if the service is absent, the callback never runs —
		// which is precisely the desired degradation, not a hang.
		const present = services.filter((s) => ctx[s] !== undefined);
		if (present.length === services.length) return fn(ctx);
		return () => {};
	},
	effect: (fn) => { fn(); return () => {}; },
	reflect: { get: () => undefined },
	connection: undefined,
};

let threw = null;
try {
	exports.apply(ctx);
} catch (error) {
	threw = error;
}

if (threw) {
	console.log("FAIL: apply() threw →", threw.message);
	process.exit(1);
}

console.log("seats touched by lazy paths:", JSON.stringify([...new Set(registered)]));
console.log("PASS: client half activates with no settingsScope, no configForms, no rpc");
