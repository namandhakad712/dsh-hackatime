// Fetch the heartbeat ingest controller and print the section that turns the
// parsed user agent into editor/operating_system, so we can see whether a
// parse error (err) rejects the heartbeat or just falls back to our fields.
const res = await fetch("https://raw.githubusercontent.com/hackclub/hackatime/main/app/services/heartbeat_ingest.rb");
const text = await res.text();
console.log("bytes:", text.length);
console.log(text);
