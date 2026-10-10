// Proves the client half registers its settings tab unconditionally — the fix
// for the tab silently never appearing. The original code gated registration
// behind ctx.inject(["configForms"])/["settingsScope"] callbacks that never
// fire on a build lacking those services, so no tab rendered. The new code
// registers settings.section directly in apply() (the dsh-pocket pattern) and
// owns no config scope at all.
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

const moduleLoader = { load(entry) { captured = entry; } };
globalThis.window = { __ModuleLoader__: moduleLoader };
new Function("require", "window", src)(fakeRequire, globalThis.window);

console.log("loader id:", captured.id);
const exports = captured.factory(fakeRequire);
console.log("exports.inject:", JSON.stringify(exports.inject));

// 0.2.0's crash: settingsScope must not be a hard dependency.
if (exports.inject.includes("settingsScope")) {
	console.log("FAIL: settingsScope is a hard inject — boot would hang");
	process.exit(1);
}
if (exports.inject.includes("configForms")) {
	console.log("FAIL: configForms must stay lazy too");
	process.exit(1);
}

// A context with NO settings service of any kind, and no connection. The tab
// must still register — that is the whole point of the fix.
const seats = [];
const registrations = [];
const ctx = {
	slots: {
		inject: (name, fn) => {
			seats.push(name);
			return fn();
		},
		register: (options, component) => {
			registrations.push({ name: options.name, id: options.id ?? options.key, component });
			return () => {};
		},
	},
	inject: (services, fn) => {
		const present = services.filter((s) => ctx[s] !== undefined);
		if (present.length === services.length) return fn(ctx);
		return () => {};
	},
	effect: (fn) => { fn(); return () => {}; },
	reflect: { get: () => undefined },
	connection: undefined,
};

try {
	exports.apply(ctx);
} catch (error) {
	console.log("FAIL: apply() threw ->", error.message);
	process.exit(1);
}

console.log("seats injected:", JSON.stringify([...new Set(seats)]));

const section = registrations.find((r) => r.name === "settings.section");
if (!section) {
	console.log("FAIL: settings.section never registered without a settings service");
	process.exit(1);
}
if (section.id !== "hackatime") {
	console.log(`FAIL: settings.section registered with id ${JSON.stringify(section.id)}, expected "hackatime"`);
	process.exit(1);
}
if (typeof section.component !== "function") {
	console.log("FAIL: settings.section registered no render component");
	process.exit(1);
}

// apply() must run its effect callbacks eagerly enough to register; confirm
// every seat got a component, not just a slot injection.
if (registrations.length < 3) {
	console.log(`FAIL: expected 3 registrations, got ${registrations.length}`);
	process.exit(1);
}

console.log(`PASS: settings.section "hackatime" registers with no settingsScope, no configForms, no rpc`);
