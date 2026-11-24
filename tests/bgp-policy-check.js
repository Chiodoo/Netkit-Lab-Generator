// Checks the BGP policy generator and validation. Run: node tests/bgp-policy-check.js
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");

const root = path.join(__dirname, "..");
const ctx = { console, window: {}, document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) } };
vm.createContext(ctx);
for (const f of ["helper.js", "bgp-policy.js", "bgp-as.js", "models/model.js", "make.js"])
	vm.runInContext(fs.readFileSync(path.join(root, "src/lab-generator", f), "utf8"), ctx, { filename: f });

function loadConfig(file) {	// same parsing and migration as the "Import configuration" menu
	const text = fs.readFileSync(path.join(root, file), "latin1");
	const cfg = JSON.parse(text.substring(text.indexOf("[")));
	cfg[0].netkit.forEach(ctx.migrateBgpPolicies);
	return cfg[0];
}

/* prefix-list ge/le validation and explanation */
const plist = { type: "prefix-list", name: "p", rules: [] };
const rule = (prefix, ge, le) => ({ seq: 10, action: "permit", prefix, ge, le });
const err = r => ctx.policyRuleError([plist], plist, r);
const explain = r => ctx.policyRuleExplain([plist], plist, r);
assert.equal(err(rule("10.0.0.0/8", null, null)), "");
assert.equal(explain(rule("10.0.0.0/8", null, null)), "Matches exactly 10.0.0.0/8 (permit, seq 10)");
assert.equal(explain(rule("10.0.0.0/8", 16, 24)), "Matches prefixes inside 10.0.0.0/8 with length from /16 to /24 (permit, seq 10)");
assert.equal(explain(rule("10.0.0.0/8", null, 24)), "Matches prefixes inside 10.0.0.0/8 with length from /8 to /24 (permit, seq 10)");
assert.equal(explain(rule("10.0.0.0/8", 16, null)), "Matches prefixes inside 10.0.0.0/8 with length from /16 to /32 (permit, seq 10)");
assert.ok(err(rule("10.0.0.0/8", 8, null)), "ge must be > prefix length");
assert.ok(err(rule("10.0.0.0/8", 24, 16)), "ge must be <= le");
assert.ok(err(rule("10.0.0.0/8", null, 33)), "le must be <= 32");
assert.ok(err(rule("10.0.0.0/16", null, 8)), "le must be >= prefix length");
assert.ok(err(rule("10.0.0.1/8", null, null)), "host bits must be zero");
assert.ok(err(rule("any", 16, null)), "no ge/le with any");
assert.ok(err(rule("10.0.0.0", null, null)), "prefix length required");

/* duplicates and references */
const dupA = { id: 1, type: "prefix-list", name: "x", rules: [{ seq: 5 }, { seq: 5 }] };
const dupB = { id: 2, type: "prefix-list", name: "x", rules: [] };
const sameNameOtherType = { id: 3, type: "access-list", name: "x", rules: [] };
assert.match(ctx.policyError([dupA, dupB, sameNameOtherType], dupB), /duplicate name/);
assert.equal(ctx.policyError([dupB, sameNameOtherType], sameNameOtherType), "");
assert.match(ctx.policyError([dupA], dupA), /duplicate sequence number 5/);

/* example configuration (FRR) */
const example = loadConfig("examples/example_bgp_policies.config");
let lab = ctx.makeFilesStructure(example.netkit, example.labInfo);
const r10 = lab.file["r10/etc/frr/frr.conf"].split("\n");
for (const line of [
	"\tno bgp ebgp-requires-policy",
	"\tneighbor 50.10.100.100 default-originate",
	"\tneighbor 50.10.200.200 prefix-list peerIn in",
	"\tneighbor 50.1.10.1 route-map providerIn in",
	"ip prefix-list providerOut seq 5 deny 100.200.0.0/16",
	"ip prefix-list providerOut seq 15 permit any",
	"route-map providerIn permit 10",
	"\tmatch ip address prefix-list providerIn",
	"\tset local-preference 50"
]) assert.ok(r10.includes(line), "r10 misses: " + line);
// order required by FRR: remote-as < neighbor policies < definitions outside "router bgp"
const last = re => r10.map((l, i) => re.test(l) ? i : -1).reduce((a, b) => Math.max(a, b));
const first = re => r10.findIndex(l => re.test(l));
assert.ok(last(/remote-as/) < first(/neighbor \S+ (prefix-list|route-map|default-originate)/));
assert.ok(last(/^\s*(network|neighbor) /) < first(/^(ip prefix-list|access-list|bgp as-path|route-map) /));

const b03 = lab.file["b03/etc/frr/frr.conf"].split("\n");
for (const line of [
	"\tneighbor 50.2.88.2 prefix-list acceptIn in",
	"\tneighbor 50.2.88.2 route-map prependOut out",
	"\tneighbor 50.2.88.2 distribute-list myAggregate out",
	"\tneighbor 50.2.88.2 filter-list viaAs2 in",
	"access-list myAggregate seq 5 permit 193.204.0.0/15 exact-match",
	"ip prefix-list acceptIn seq 5 permit 100.0.0.0/8 ge 16 le 16",
	"ip prefix-list acceptIn seq 10 permit 50.0.0.0/8 le 24",
	"bgp as-path access-list viaAs2 seq 5 permit ^2_",
	"\tmatch ip address myAggregate",
	"\tmatch as-path viaAs2",
	"\tset as-path prepend 137 137",
	"\tset community 137:100",
	"route-map prependOut permit 20"
]) assert.ok(b03.includes(line), "b03 misses: " + line);
// r20 must not reference 50.2.88.88 (b03 is not its neighbor: the typo of the original exam lab)
assert.ok(!lab.file["r20/etc/frr/frr.conf"].includes("50.2.88.88"));
assert.ok(!/skipped/.test(Object.values(lab.file).join("")), "example has invalid rules");

/* same configuration with quagga */
example.netkit.forEach(m => m.routingSoftware = "quagga");
lab = ctx.makeFilesStructure(example.netkit, example.labInfo);
const q = lab.file["b03/etc/zebra/bgpd.conf"].split("\n");
assert.ok(q.includes("access-list myAggregate permit 193.204.0.0/15 exact-match"));
assert.ok(q.includes("ip as-path access-list viaAs2 permit ^2_"));
assert.ok(!q.some(l => /ebgp-requires-policy/.test(l)));
assert.ok(q.indexOf("ip prefix-list acceptIn seq 5 permit 100.0.0.0/8 ge 16 le 16") < q.indexOf("log file /var/log/zebra/bgpd.log"));

/* invalid rules are not generated, a comment says why */
const bad = loadConfig("examples/example_bgp_policies.config");
const badR10 = bad.netkit.find(m => m.name == "r10");
badR10.routing.bgp.policies[0].rules[0].le = 8;
lab = ctx.makeFilesStructure(bad.netkit, bad.labInfo);
assert.match(lab.file["r10/etc/frr/frr.conf"], /! prefix-list peerIn seq 5 skipped: le must not be smaller/);

/* values from an imported file cannot escape the generated config or the echo quoting of the .sh script */
const evil = loadConfig("examples/example_bgp_policies.config");
const evilB03 = evil.netkit.find(m => m.name == "b03").routing.bgp;
evilB03.policies.find(p => p.name == "acceptIn").rules[0].seq = "5'; touch pwned; '\nip route 0.0.0.0/0 1.2.3.4";
evilB03.policies.find(p => p.name == "viaAs2").name = "x'; touch pwned; '";
evilB03.free = "! it's free text";
lab = ctx.makeFilesStructure(evil.netkit, evil.labInfo);
const evilConf = lab.file["b03/etc/frr/frr.conf"];
assert.ok(!/pwned|ip route/.test(evilConf), "raw values copied into the config");
assert.match(evilConf, /match as-path: the as-path has an invalid name/);
assert.ok(ctx.makeScript(lab).includes("echo '! it'\\''s free text' >> b03/etc/frr/frr.conf"));
// file names are quoted when needed, machine names must be plain words
assert.ok(ctx.makeScript({ folders: ["a b"], file: { "x;y": "z" } }).includes("touch 'x;y'\necho 'z' >> 'x;y'"));
evil.netkit[0].name = "../escape";
assert.equal(Object.keys(ctx.makeFilesStructure(evil.netkit, evil.labInfo).file).length, 0);

/* configurations exported before policies existed still work */
const old = loadConfig("examples/example_lab.config");
assert.ok(old.netkit.every(m => Array.isArray(m.routing.bgp.policies)));
lab = ctx.makeFilesStructure(old.netkit, old.labInfo);
assert.ok(!/prefix-list|route-map|access-list/.test(Object.values(lab.file).join("")));

/* route-maps on redistribute statements (RIP, OSPF, BGP) */
{
	const cfg = loadConfig("examples/example_bgp_policies.config");
	const r = cfg.netkit.find(m => m.name == "r10"), routing = r.routing, pol = routing.bgp.policies;
	const peers = { id: 901, type: "prefix-list", name: "peers", rules: [{ seq: 5, action: "permit", prefix: "50.1.10.0/24", ge: null, le: 32 }] };
	const rm = { id: 902, type: "route-map", name: "toIgp", rules: [
		{ seq: 10, action: "permit", matches: [{ match: "ip next-hop prefix-list", value: 901 }], sets: [{ set: "metric", value: "5" }, { set: "tag", value: "7" }] },
		{ seq: 20, action: "permit", matches: [{ match: "interface", value: "eth1" }], sets: [{ set: "metric-type", value: "type-1" }] }] };
	pol.push(peers, rm);
	Object.assign(routing.rip, { en: true, network: ["50.0.0.0/8"], connected: true, bgp: true, rmap: { bgp: 902 } });
	Object.assign(routing.ospf, { en: true, network: ["50.0.0.0/8"], connected: true, rmap: { connected: 902 } });
	Object.assign(routing.bgp, { connected: true, rmap: { connected: 902 } });
	let conf = ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file["r10/etc/frr/frr.conf"].split("\n");
	for (const line of [
		"\tredistribute connected", "\tredistribute bgp route-map toIgp", "\tredistribute connected route-map toIgp",
		"ip prefix-list peers seq 5 permit 50.1.10.0/24 le 32", "route-map toIgp permit 10", "\tmatch ip next-hop prefix-list peers",
		"\tset metric 5", "\tset tag 7", "\tmatch interface eth1", "\tset metric-type type-1"
	]) assert.ok(conf.includes(line), "r10 misses: " + line);
	assert.equal(conf.filter(l => l == "\tredistribute connected route-map toIgp").length, 2, "ospf and bgp");
	assert.ok(conf.indexOf("router bgp 10") < conf.indexOf("\tredistribute connected route-map toIgp", conf.indexOf("router bgp 10")));
	assert.deepEqual(ctx.policyReferences(routing, rm), ["rip redistribute bgp", "ospf redistribute connected", "bgp redistribute connected"]);
	assert.deepEqual(ctx.policyReferences(routing, peers), ["route-map toIgp seq 10"]);
	assert.equal(ctx.policyRuleExplain(pol, rm, rm.rules[1]), "Announcements matching interface eth1 are accepted with metric-type type-1 (permit, seq 20)");
	assert.match(ctx.policyRuleError(pol, rm, { seq: 30, action: "permit", matches: [{ match: "interface", value: "" }], sets: [] }), /interface name/);
	assert.match(ctx.policyRuleError(pol, rm, { seq: 30, action: "permit", matches: [], sets: [{ set: "metric-type", value: "3" }] }), /type-1 or type-2/);

	// without bgp: only the route-maps of the redistribute statements and their lists, after the IGP blocks
	routing.bgp.en = false;
	conf = ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file["r10/etc/frr/frr.conf"];
	assert.ok(conf.includes("route-map toIgp permit 10") && conf.includes("ip prefix-list peers seq 5"));
	assert.ok(!conf.includes("providerIn"), "unused policies are not written without bgp");
	assert.ok(conf.indexOf("router ospf") < conf.indexOf("ip prefix-list peers"));

	// quagga: every daemon reads only its own file
	r.routingSoftware = "quagga";
	const files = ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file;
	assert.match(files["r10/etc/zebra/ripd.conf"], /\tredistribute bgp route-map toIgp\n[\s\S]*ip prefix-list peers seq 5 permit 50.1.10.0\/24 le 32\n[\s\S]*route-map toIgp permit 10\n/);
	assert.match(files["r10/etc/zebra/ospfd.conf"], /\tredistribute connected route-map toIgp\n/);
	assert.ok(files["r10/etc/zebra/ripd.conf"].indexOf("route-map toIgp") < files["r10/etc/zebra/ripd.conf"].indexOf("log file"));

	// a route-map that no longer exists: the statement is skipped, not written without it
	routing.rip.rmap.bgp = 999;
	assert.match(ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file["r10/etc/zebra/ripd.conf"], /! redistribute bgp skipped/);
}

/* loopback: startup line (the course form), suggestions */
{
	const cfg = loadConfig("examples/example_bgp_policies.config");
	const r1 = cfg.netkit.find(m => m.name == "r1"), r2 = cfg.netkit.find(m => m.name == "r2");
	r1.routing.loopback = { en: true, ip: "2.2.2.2" };
	r2.routing.loopback = { en: true, ip: "3.3.3.3/32" };
	const files = ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file;
	assert.match(files["r1.startup"], /dev eth\d+\nip address add 2.2.2.2\/32 dev lo:0\n/);
	assert.ok(files["r2.startup"].includes("ip address add 3.3.3.3/32 dev lo:0\n"));
	r1.routing.loopback.ip = "2.2.2";
	assert.ok(!ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file["r1.startup"].includes("lo:0"), "invalid loopback not generated");
	r1.routing.loopback.ip = "2.2.2.2";
	let s = ctx.labSuggestions(cfg.netkit);
	const i2 = cfg.netkit.indexOf(r2);
	assert.ok(s.networks.some(n => n.value == "2.2.2.2/32" && n.label == "loopback of r1"));
	assert.notEqual(r1.routing.bgp.as, r2.routing.bgp.as);
	assert.deepEqual(s.loopbacks[i2], [], "loopbacks of other ASes are not offered for iBGP");
	r2.routing.bgp.as = r1.routing.bgp.as;
	s = ctx.labSuggestions(cfg.netkit);
	assert.deepEqual(s.loopbacks[i2].map(l => l.value + " " + l.name), ["2.2.2.2 r1"]);
	assert.ok(s.peers[i2].some(p => p.value == "2.2.2.2" && p.label == "r1 loopback (iBGP)"));
}

/* suggestions: r20 peers are the routers on its collision domains */
const sugg = ctx.labSuggestions(loadConfig("examples/example_bgp_policies.config").netkit);
const idx = example.netkit.findIndex(m => m.name == "r20");
assert.deepEqual(sugg.peers[idx].map(p => p.value).sort(), ["50.2.20.2", "50.20.200.200"]);
assert.ok(sugg.networks.some(n => n.value == "193.204.0.0/15"));

console.log("bgp-policy-check: all checks passed");
