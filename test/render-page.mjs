// Renders the settings page's full element tree against a fake React, so a
// broken createElement call (a typo'd style key, a missing helper) fails here
// instead of in the browser. Applies the dsh-pocket shape: the page receives
// only { rpcCall } and pulls everything else over the channel.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "lib", "client.js");
const src = fs.readFileSync(file, "utf8");

let captured;
globalThis.window = { __ModuleLoader__: { load: (entry) => { captured = entry; } } };
const reactCalls = [];

// A createElement that records the tag and every text leaf, so the test can
// assert the new panels actually rendered rather than just "something did".
const textLeaves = [];
const effects = [];
const createElement = (tag, props, ...children) => {
	reactCalls.push(String(tag));
	const walk = (child) => {
		if (child === null || child === undefined || typeof child === "boolean") return;
		if (Array.isArray(child)) { child.forEach(walk); return; }
		if (typeof child === "string") { textLeaves.push(child); return; }
		if (typeof child === "number") { textLeaves.push(String(child)); return; }
	};
	children.forEach(walk);
	return { $$typeof: Symbol.for("react.element"), type: tag, props: props ?? {}, children };
};

// Effects run after render; the async RPC loads inside them populate
// config/status/version on the following tick.
const flushEffects = async () => {
	const pending = effects.splice(0, effects.length);
	for (const fn of pending) {
		const cleanup = fn();
		if (cleanup && typeof cleanup.then === "function") await cleanup;
	}
	// The RPC calls are async; let their resolutions land.
	await new Promise((r) => setTimeout(r, 0));
};

const hooks = {
	config: null,
	version: { current: "0.3.1", latest: "0.3.1", updateAvailable: false },
	status: {
		submitted: 3, lastSubmitAt: Date.now() - 60_000, pending: 1,
		apiUrl: "https://hackatime.hackclub.com/api/hackatime/v1", hasApiKey: true,
		session: { id: "abcd1234", project: "Hackatime-dsh", entity: "lib/index.js", model: "Atria-Dawn-Preview", lastActivityAt: Date.now() - 5_000 },
	},
};
let hookIndex = 0;
const stateBucket = {};
const useState = (initial) => {
	const key = hookIndex++;
	if (!(key in stateBucket)) stateBucket[key] = typeof initial === "function" ? initial() : initial;
	return [stateBucket[key], (v) => { stateBucket[key] = typeof v === "function" ? v(stateBucket[key]) : v; }];
};
const useEffect = (fn) => { effects.push(fn); };

const fakeRequire = (name) => {
	if (name === "react") return {
		createElement,
		useState,
		useEffect,
		useSyncExternalStore: () => ({ value: {} }),
		useCallback: (fn) => fn,
	};
	throw new Error(`unexpected require: ${name}`);
};

new Function("require", "window", src)(fakeRequire, globalThis.window);
const exports = captured.factory(fakeRequire);
if (exports.inject[0] !== "slots") {
	console.log("FAIL: unexpected inject", JSON.stringify(exports.inject));
	process.exit(1);
}

// Pull the registered page out of the slot wiring.
let page = null;
const ctx = {
	slots: {
		inject: (name, fn) => fn(),
		register: (options, component) => { if (options.id === "hackatime") page = component; return () => {}; },
	},
	effect: (fn) => { fn(); return () => {}; },
	connection: {
		rpc: {
			call: async (channel, endpoint) => {
				if (endpoint === "hackatime.config.get") return { ok: true, value: { enabled: true, apiKey: "", autoUpdate: true, sendAiUsage: true } };
				if (endpoint === "hackatime.status") return { ok: true, value: hooks.status };
				if (endpoint === "hackatime.version") return { ok: true, value: hooks.version };
				return { ok: false, error: { code: "bad-request", message: "?" } };
			},
		},
	},
};

try {
	exports.apply(ctx);
} catch (error) {
	console.log("FAIL: apply() threw ->", error.message);
	process.exit(1);
}

if (typeof page !== "function") {
	console.log("FAIL: settings.section never registered a component");
	process.exit(1);
}

// The page reads config over RPC. Render once (effects schedule the loads),
// let the async resolutions land, then render again with the populated state.
// The page receives the same wrapped rpcCall the real slot injects, not the
// raw rpc.call — the wrapper pins the channel and swaps (endpoint, payload)
// into (channel, endpoint, payload).
const makeRpcCall = (ctxRef) => (endpoint, payload) => {
	const connection = ctxRef.connection ?? ctxRef.get?.("connection");
	const rpc = connection?.rpc;
	if (!rpc?.call) return Promise.resolve({ ok: false, error: { code: "unavailable", message: "RPC unavailable" } });
	return Promise.resolve(rpc.call("/dsh-hackatime", endpoint, payload));
};

const renderSettled = async () => {
	reactCalls.length = 0;
	textLeaves.length = 0;
	effects.length = 0;
	hookIndex = 0;
	page({ rpcCall: makeRpcCall(ctx) });
	await flushEffects();
	reactCalls.length = 0;
	textLeaves.length = 0;
	effects.length = 0;
	hookIndex = 0;
	page({ rpcCall: makeRpcCall(ctx) });
	await flushEffects();
	return textLeaves.join(" ");
};

try {
	await renderSettled();
	const flat = reactCalls.join(",");
	if (!flat.includes("section")) {
		console.log("FAIL: page rendered no sections");
		process.exit(1);
	}
	const text = textLeaves.join(" ");
	if (!text.includes("Hackatime-dsh")) {
		console.log("DEBUG text:", JSON.stringify(text.slice(0, 600)));
	}
	for (const expected of ["Currently tracking", "Connection", "How to use it", "Hackatime-dsh", "Atria-Dawn-Preview", "Track coding time"]) {
		if (!text.includes(expected)) {
			console.log(`FAIL: page is missing expected text "${expected}"`);
			process.exit(1);
		}
	}
	console.log("render ok: elements built =", reactCalls.length);
} catch (error) {
	console.log("FAIL: page render threw ->", error.message);
	console.log(error.stack?.split("\n").slice(0, 5).join("\n"));
	process.exit(1);
}

// Second render with an update available — exercises the update banner branch.
for (const key of Object.keys(stateBucket)) delete stateBucket[key];
hooks.version = { current: "0.3.1", latest: "0.4.0", updateAvailable: true };
try {
	const text = await renderSettled();
	if (!text.includes("0.4.0 is available")) {
		console.log('FAIL: update banner missing "0.4.0 is available"');
		process.exit(1);
	}
	if (!text.includes("Update now")) {
		console.log('FAIL: update banner missing the "Update now" button');
		process.exit(1);
	}
	console.log("render ok: update-available branch built =", reactCalls.length, "elements");
} catch (error) {
	console.log("FAIL: update banner render threw ->", error.message);
	process.exit(1);
}

console.log("PASS: settings page renders status, live session and update branches");
process.exit(0);
