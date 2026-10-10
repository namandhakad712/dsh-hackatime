// Confirms the published tarball carries the FIXED client half:
//  - unconditional settings.section registration (the fix)
//  - no configForms/settingsScope gating (the old, broken approach)
//  - RPC config endpoints (the new data path)
import fs from "node:fs";
import zlib from "node:zlib";

const tgz = process.argv[2];
const out = zlib.gunzipSync(fs.readFileSync(tgz)).toString("latin1");

const client = out.split("package/lib/client.js")[1] ?? "";
const index = out.split("package/lib/index.js")[1] ?? "";

const strip = (blob) => blob.split("\n").filter((l) => !l.startsWith("\u0000")).join("\n");

const c = strip(client);
const i = strip(index);

const checks = [
	["client: registers settings.section", c.includes("settings.section")],
	["client: registers plugins.bundle.config", c.includes("plugins.bundle.config")],
	["client: RPC config.get", c.includes("hackatime.config.get")],
	["client: RPC config.set", c.includes("hackatime.config.set")],
	["client: NO configForms gate", !c.includes('ctx.inject(["configForms"]')],
	["client: NO settingsScope gate", !c.includes('ctx.inject(["settingsScope"]')],
	["host: config.get endpoint", i.includes("hackatime.config.get")],
	["host: config.set endpoint", i.includes("hackatime.config.set")],
	["host: config.unset endpoint", i.includes("hackatime.config.unset")],
	["host: volatile config fields", i.includes(".volatile()")],
];

let failed = 0;
for (const [label, ok] of checks) {
	if (!ok) failed += 1;
	console.log(`${ok ? "ok  " : "FAIL"} ${label}`);
}

process.exit(failed === 0 ? 0 : 1);
