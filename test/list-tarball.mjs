// Lists the file names inside a published npm tarball so we can confirm the
// fixed client/host halves actually shipped (and the icon is present).
import fs from "node:fs";
import zlib from "node:zlib";

const tgz = process.argv[2];
const buf = fs.readFileSync(tgz);
const out = zlib.gunzipSync(buf).toString("latin1");
const names = [...out.matchAll(/package\/[^\x00-\x1f"'|]+/g)].map((m) => m[0]);
const unique = [...new Set(names)].filter((n) => n.split("/").length <= 3);
console.log(unique.join("\n"));
