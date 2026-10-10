// List docs/editors entries and fetch one example editor doc to learn the format.
const res = await fetch("https://api.github.com/repos/hackclub/hackatime/git/trees/main?recursive=1", {
	headers: { "User-Agent": "dsh-hackatime-recon", "Accept": "application/vnd.github+json" },
});
const data = await res.json();
const docs = data.tree.filter((e) => e.path.startsWith("docs/editors/")).map((e) => e.path);
console.log("count:", docs.length);
console.log("deepseek present:", docs.some((d) => /deepseek|dsh/i.test(d)));
console.log(docs.slice(0, 6).join("\n"));

const ex = await fetch("https://raw.githubusercontent.com/hackclub/hackatime/main/docs/editors/emacs.md");
console.log("\n=== emacs.md ===\n" + (await ex.text()));
