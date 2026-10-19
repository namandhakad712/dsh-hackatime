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
// The browser RPC carrier must be a declared dependency: Cordis only exposes
// the services a client half lists in `inject`, so a missing "connection"
// entry leaves ctx.connection undefined and every call settling as
// "unavailable" — which renders the whole card with every field disabled.
if (!exports.inject.includes("connection")) {
	console.log("FAIL: inject must include \"connection\" or the card cannot reach the host ->", JSON.stringify(exports.inject));
	process.exit(1);
}
console.log("inject ok:", JSON.stringify(exports.inject));

// Pull the registered page out of the slot wiring.
let page = null;
// Simulate Cordis: only the declared services exist on the context. Anything
// not listed in `inject` is simply absent, so a lookup the code assumes is
// always present shows up here as undefined, exactly as in the browser.
const ctx = Object.fromEntries(exports.inject.map((name) => {
	if (name === "slots") return [name, {
		inject: (n, fn) => fn(),
		register: (options, component) => { if (options.id === "hackatime") page = component; return () => {}; },
	}];
	if (name === "connection") return [name, {
		rpc: {
			call: async (channel, endpoint) => {
				if (endpoint === "hackatime.config.get") return { ok: true, value: { enabled: true, apiKey: "", autoUpdate: true, sendAiUsage: true } };
				if (endpoint === "hackatime.status") return { ok: true, value: hooks.status };
				if (endpoint === "hackatime.version") return { ok: true, value: hooks.version };
				return { ok: false, error: { code: "bad-request", message: "?" } };
			},
		},
	}];
	return [name, {}];
}));
// `effect` is a context lifecycle method, not an injected service.
ctx.effect = (fn) => { fn(); return () => {}; };

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
	for (const expected of ["Currently tracking", "Connection", "How it works", "Hackatime-dsh", "Atria-Dawn-Preview", "Connect your Hackatime account", "Advanced settings"]) {
		if (!text.includes(expected)) {
			console.log(`FAIL: page is missing expected text "${expected}"`);
			process.exit(1);
		}
	}
	// The whole point of the redesign: the API-key hero is visible by default
	// and the advanced plumbing is NOT — a first-time user sees one job.
	if (text.includes("WakaTime's default is 30")) {
		console.log("FAIL: advanced rate-limit help leaked into the default view");
		process.exit(1);
	}
	// The Save button lives inside the setup panel now (paste → save in one
	// motion), not at the bottom of the page.
	if (text.includes("Paste it below and press Save")) {
		console.log("FAIL: numbered onboarding must hide once a key is present");
		process.exit(1);
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

// --- the redesign contract -------------------------------------------------

// The card now reports the foreground window's workspace to the host so the
// status names the project the user is actually looking at. Verify the poll
// carries `activeCwd` through, and that it degrades to null when the client
// has no sessions service (older builds, headless).
{
	const seen = [];
	const probe = (endpoint, payload) => {
		seen.push([endpoint, payload]);
		if (endpoint === "hackatime.status") return Promise.resolve({ ok: true, value: hooks.status });
		if (endpoint === "hackatime.config.get") return Promise.resolve({ ok: true, value: {} });
		if (endpoint === "hackatime.version") return Promise.resolve({ ok: true, value: hooks.version });
		return Promise.resolve({ ok: true, value: null });
	};
	for (const key of Object.keys(stateBucket)) delete stateBucket[key];
	hooks.version = { current: "0.3.1", latest: "0.3.1", updateAvailable: false };

	const renderWith = (ctxRef) => async () => {
		// Two renders with a flush between: the first schedules the effects,
		// the flush lets the async RPC resolutions land, the second paints
		// with the populated state — the same reason renderSettled doubles up.
		for (let pass = 0; pass < 2; pass++) {
			reactCalls.length = 0; textLeaves.length = 0; effects.length = 0; hookIndex = 0;
			page({ rpcCall: probe, activeCwd: () => ctxRef.activeCwd ?? null });
			await flushEffects();
		}
		return textLeaves.join(" ");
	};

	// Foreground window known: the poll carries its workspace path.
	const r1 = await renderWith({ activeCwd: "C:/Projects/Hackatime-dsh" })();
	const statusCall = seen.find(([endpoint]) => endpoint === "hackatime.status");
	if (statusCall?.[1]?.activeCwd !== "C:/Projects/Hackatime-dsh") {
		console.log("FAIL: status poll did not carry the foreground workspace ->", JSON.stringify(statusCall?.[1]));
		process.exit(1);
	}
	if (!r1.includes("Hackatime-dsh")) {
		console.log("FAIL: live panel did not render the session project");
		process.exit(1);
	}
	console.log("ok: status poll carries the foreground workspace");

	// No sessions service: degrades to null, host keeps the last known session.
	seen.length = 0;
	await renderWith({})();
	const fallback = seen.find(([endpoint]) => endpoint === "hackatime.status");
	if (fallback?.[1]?.activeCwd !== null) {
		console.log("FAIL: activeCwd should degrade to null without a sessions service ->", JSON.stringify(fallback?.[1]));
		process.exit(1);
	}
	console.log("ok: activeCwd degrades to null without a sessions service");

	// No API key anywhere: the numbered onboarding appears; with a key it must
	// disappear again. Both directions matter — the steps are the entire
	// first-run experience, and leaving them up after setup is clutter.
	const savedHasApiKey = hooks.status.hasApiKey;
	hooks.status = { ...hooks.status, hasApiKey: false };
	for (const key of Object.keys(stateBucket)) delete stateBucket[key];
	const noKey = await renderWith({})();
	if (!noKey.includes("Paste it below and press Save")) {
		console.log("FAIL: numbered onboarding missing when no API key is set");
		process.exit(1);
	}
	hooks.status = { ...hooks.status, hasApiKey: savedHasApiKey };
	for (const key of Object.keys(stateBucket)) delete stateBucket[key];
	const withKey = await renderWith({})();
	if (withKey.includes("Paste it below and press Save")) {
		console.log("FAIL: numbered onboarding stayed up after a key is present");
		process.exit(1);
	}
	console.log("ok: numbered onboarding shows only before a key is set");

	// The disclosure: closed by default, the advanced rows appear only after
	// the toggle fires. `showAdvanced` is a useState slot, so flipping the
	// recorded state and re-rendering simulates the click.
	for (const key of Object.keys(stateBucket)) delete stateBucket[key];
	const closed = await renderWith({})();
	if (closed.includes("WakaTime's default is 30")) {
		console.log("FAIL: advanced fields visible before the disclosure is opened");
		process.exit(1);
	}
	// The useState slots are created in render order; find the boolean slot
	// that starts false and flip it, then re-render to emulate the click.
	const before = Object.keys(stateBucket).length;
	await renderWith({})();
	const falseSlots = Object.keys(stateBucket).filter((k) => stateBucket[k] === false);
	const boolSlot = falseSlots[falseSlots.length - 1];
	if (boolSlot === undefined) {
		console.log("FAIL: could not locate the showAdvanced state slot among", before, "slots ->", JSON.stringify(stateBucket));
		process.exit(1);
	}
	stateBucket[boolSlot] = true;
	const opened = await renderWith({})();
	if (!opened.includes("WakaTime's default is 30") || !opened.includes("Track coding time")) {
		console.log("FAIL: opening the disclosure did not reveal the advanced settings");
		process.exit(1);
	}
	console.log("ok: advanced settings hidden until the disclosure is opened");
}

console.log("PASS: settings page renders status, live session, onboarding hero and disclosure");
process.exit(0);
