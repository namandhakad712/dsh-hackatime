// Host-half activation: apply() must settle with only the core `settings`
// service present and no `connection` (resolved lazily). Confirms the RPC
// registration can never block activation.
import fs from "node:fs";
import path from "node:path";
import url from "node:url";

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const file = path.join(__dirname, "..", "lib", "index.js");
const src = fs.readFileSync(file, "utf8");

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

// apply() with `settings` present and `connection` absent: the RPC registration
// is lazy, so nothing may throw and activation must settle.
const fakeCtx = {
	inject: (services, fn) => {
		if (services.every((s) => s === "settings")) return fn(fakeCtx);
		return () => {};
	},
	effect: (fn) => { fn(); return () => {}; },
	on: () => () => {},
	logger: { info() {}, warn() {}, error() {} },
	settings: { register: () => {} },
};

try {
	modExports.apply(fakeCtx, { enabled: true });
} catch (error) {
	console.log("FAIL: apply() threw ->", error.message);
	process.exit(1);
}

console.log("PASS: host half activates with settings only; connection stays lazy");
