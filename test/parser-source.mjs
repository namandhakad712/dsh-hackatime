// Fetch the UA parser source and print only the legacy-parse methods, so we
// can see exactly how a bare "dsh-hackatime/0.1.0" user_agent becomes "dsh".
const res = await fetch("https://raw.githubusercontent.com/hackclub/hackatime/main/app/services/wakatime_user_agent_parser.rb");
const text = await res.text();
console.log("bytes:", text.length);

const methods = [
	"def self.parse_browser_or_legacy_user_agent",
	"def self.parse_legacy_platform_product_user_agent",
	"def self.parse_legacy_os_editor_user_agent",
	"def self.parse_legacy_version_editor_user_agent",
	"def self.parse_legacy_wakatime_editor_user_agent",
	"def self.user_agent_products",
	"def self.extract_editor",
	"def self.editor_from_platform",
	"def self.plugin_base",
	"def self.plugin_product?",
	"def self.normalize_editor",
	"def self.direct_user_agent_os",
	"def self.meaningful_product?",
	"def self.editor_first_product_chain?",
	"def self.shift_first_non_metadata_product!",
	"def self.normalize_os",
];

for (const m of methods) {
	const i = text.indexOf(m);
	if (i < 0) { console.log(`\n=== NOT FOUND: ${m}`); continue; }
	let j = text.indexOf("\n  def ", i + m.length);
	// include private defs too
	let k = text.indexOf("\n    def ", i + m.length);
	const ends = [j, k].filter((x) => x > 0);
	const end = ends.length ? Math.min(...ends) : Math.min(text.length, i + 1800);
	console.log(`\n=== ${m} (chars ${i}-${end}) ===`);
	console.log(text.slice(i, end));
}
