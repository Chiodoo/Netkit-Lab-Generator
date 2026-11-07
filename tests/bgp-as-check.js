// Checks AS relationships, policy models and link preferences. Run: node tests/bgp-as-check.js
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");

const root = path.join(__dirname, "..");
const ctx = { console, window: {}, document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) } };
vm.createContext(ctx);
for (const f of ["helper.js", "bgp-policy.js", "bgp-as.js", "models/model.js", "make.js", "lint.js"])
	vm.runInContext(fs.readFileSync(path.join(root, "src/lab-generator", f), "utf8"), ctx, { filename: f });

function parse(text) {	// same parsing and migration as the "Import configuration" menu
	const cfg = JSON.parse(text.substring(text.indexOf("[")))[0];
	cfg.netkit.forEach(ctx.migrateBgpPolicies);
	ctx.migrateBgpAs(cfg.labInfo);
	return cfg;
}
const load = file => parse(fs.readFileSync(path.join(root, file), "latin1"));
const conf = (cfg, name) => ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file[name + "/etc/frr/frr.conf"];
const bgpLines = text => text.split("\n").filter(l => /^\t?(neighbor \S+ route-map|bgp as-path|route-map|\tmatch|\tset)/.test(l)).map(l => l.trim());
const machine = (cfg, name) => cfg.netkit.find(m => m.name == name);
const remote = (cfg, name, ip) => machine(cfg, name).routing.bgp.remote.find(r => r.neighbor == ip);
const lint = cfg => ctx.lintLab(cfg.netkit, cfg.labInfo.bgpAs).map(i => i.level + ": " + i.text);
const EXAMPLE = "examples/example_bgp_relationships.config";

/* relationships are symmetric, one per pair */
const a = { relations: [], ases: {} };
ctx.setAsRole(a, "10", "1", "provider");
assert.equal(ctx.asRole(a, "10", "1"), "provider");
assert.equal(ctx.asRole(a, "1", "10"), "customer");
ctx.setAsRole(a, "1", "10", "peer");	// edited from the other side: replaces the old one
assert.equal(a.relations.length, 1);
assert.equal(ctx.asRole(a, "10", "1"), "peer");
assert.match(ctx.addAsRelationError(a, "10", "1", "customer"), /already a peer/);
assert.match(ctx.addAsRelationError(a, "10", "10", "peer"), /itself/);
assert.match(ctx.addAsRelationError(a, "10", "abc", "peer"), /between 1 and/);
assert.equal(ctx.addAsRelationError(a, "10", "65000", "customer"), "");
ctx.setAsRole(a, "10", "1", "");
assert.equal(a.relations.length, 0);

/* model Both everywhere: r10 as in the expected output */
let cfg = load(EXAMPLE);
assert.deepEqual(lint(cfg), [], "the example has no problems");
assert.deepEqual(bgpLines(conf(cfg, "r10")), [
	"neighbor 50.10.1.2 route-map AS1-IN in",
	"neighbor 50.10.1.2 route-map AS1-OUT out",
	"neighbor 110.220.0.1 route-map AS20-IN in",
	"neighbor 110.220.0.1 route-map AS20-OUT out",
	"neighbor 50.100.10.4 route-map AS100-IN in",
	"bgp as-path access-list NON-CUSTOMER-ROUTES seq 5 permit ^1_",
	"bgp as-path access-list NON-CUSTOMER-ROUTES seq 10 permit ^20_",
	"route-map AS1-IN permit 10",
	"set local-preference 100",
	"route-map AS20-IN permit 10",
	"set local-preference 200",
	"route-map AS100-IN permit 10",
	"set local-preference 300",
	"route-map AS1-OUT deny 10",
	"match as-path NON-CUSTOMER-ROUTES",
	"route-map AS1-OUT permit 20",
	"route-map AS20-OUT deny 10",
	"match as-path NON-CUSTOMER-ROUTES",
	"route-map AS20-OUT permit 20"
]);
// tier-1 AS1: customer AS10, peer AS2
assert.ok(bgpLines(conf(cfg, "r1")).includes("bgp as-path access-list NON-CUSTOMER-ROUTES seq 5 permit ^2_"));
assert.ok(conf(cfg, "r10").includes("\tno bgp ebgp-requires-policy"), "the flag is kept");

/* export/import round trip, same configuration */
const exported = JSON.stringify([{ labInfo: cfg.labInfo, netkit: cfg.netkit }], undefined, 4);
assert.equal(conf(parse(exported), "r10"), conf(cfg, "r10"));

/* proposed (not applied) route-maps are not generated and Check Lab says so */
cfg = load(EXAMPLE);
remote(cfg, "r10", "50.10.1.2").auto.out = "";
assert.ok(!conf(cfg, "r10").includes("AS1-OUT"));
assert.ok(lint(cfg).some(t => /^warning: r10: 1 auto-generated route-map\(s\) not applied yet \(AS1-OUT out\)/.test(t)));
remote(cfg, "r10", "50.10.1.2").auto.out = "discarded";
assert.deepEqual(lint(cfg), []);

/* a manual route-map on the same neighbor/direction: never overwritten, error */
cfg = load(EXAMPLE);
let r10 = machine(cfg, "r10").routing.bgp;
r10.policies.push({ id: 7, type: "route-map", name: "mine", rules: [{ seq: 10, action: "permit", matches: [], sets: [] }] });
remote(cfg, "r10", "50.10.1.2").apply["route-map"].out = 7;
let lines = bgpLines(conf(cfg, "r10"));
assert.ok(lines.includes("neighbor 50.10.1.2 route-map mine out") && !lines.includes("neighbor 50.10.1.2 route-map AS1-OUT out"));
assert.ok(lint(cfg).some(t => /^error: r10 neighbor 50.10.1.2: the auto-generated route-map AS1-OUT out is applied but route-map mine is assigned too/.test(t)));

/* Edit: the route-map and its as-path list become manual policies, the configuration does not change */
cfg = load(EXAMPLE);
const before = conf(cfg, "r10");
let s = ctx.autoSessions(machine(cfg, "r10"), cfg.labInfo.bgpAs).find(x => x.policy.name == "AS1-OUT");
ctx.detachAutoSession(machine(cfg, "r10"), s);
r10 = machine(cfg, "r10").routing.bgp;
assert.deepEqual(r10.policies.map(p => p.type + " " + p.name), ["as-path NON-CUSTOMER-ROUTES", "route-map AS1-OUT"]);
assert.equal(remote(cfg, "r10", "50.10.1.2").auto.out, "edited");
assert.deepEqual(bgpLines(conf(cfg, "r10")).sort(), bgpLines(before).sort());	// one NON-CUSTOMER-ROUTES, reused by AS20-OUT
r10.policies[0].rules.pop();	// the manual list changes: the generated one gets its own name
assert.ok(conf(cfg, "r10").includes("bgp as-path access-list NON-CUSTOMER-ROUTES-AUTO seq 10 permit ^20_"));

/* backup link (multi-homed stub lab): local-pref 100 - 10 = 90 in, MED 10 on everything out */
cfg = load(EXAMPLE);
cfg.labInfo.bgpAs.ases["100"].model = "none";
Object.assign(remote(cfg, "r100", "50.100.10.2").pref, { mode: "backup" });
remote(cfg, "r100", "50.100.10.2").auto = { in: "applied", out: "applied" };
assert.deepEqual(bgpLines(conf(cfg, "r100")), [
	"neighbor 50.100.10.2 route-map AS10-BACKUP-IN in",
	"neighbor 50.100.10.2 route-map AS10-BACKUP-OUT out",
	"route-map AS10-BACKUP-IN permit 10",
	"set local-preference 90",
	"route-map AS10-BACKUP-OUT permit 10",
	"set metric 10"
]);
// with Both: provider class 100 - 10, the export filter stays first
cfg.labInfo.bgpAs.ases["100"].model = "both";
assert.deepEqual(bgpLines(conf(cfg, "r100")), [
	"neighbor 50.100.10.2 route-map AS10-BACKUP-IN in",
	"neighbor 50.100.10.2 route-map AS10-BACKUP-OUT out",
	"bgp as-path access-list NON-CUSTOMER-ROUTES seq 5 permit ^10_",
	"route-map AS10-BACKUP-IN permit 10",
	"set local-preference 90",
	"route-map AS10-BACKUP-OUT deny 10",
	"match as-path NON-CUSTOMER-ROUTES",
	"route-map AS10-BACKUP-OUT permit 20",
	"set metric 10"
]);
// custom values
Object.assign(remote(cfg, "r100", "50.100.10.2").pref, { mode: "custom", lp: 42, med: "" });
lines = bgpLines(conf(cfg, "r100"));
assert.ok(lines.includes("set local-preference 42") && !lines.some(l => /metric/.test(l)) && lines.includes("route-map AS10-CUSTOM-OUT permit 20"));
// invalid values are skipped with a comment, never copied
Object.assign(remote(cfg, "r100", "50.100.10.2").pref, { mode: "backup", delta: "5\nip route 0.0.0.0/0 1.2.3.4" });
assert.ok(!/ip route/.test(conf(cfg, "r100")) && /skipped: set local-preference/.test(conf(cfg, "r100")));

/* warnings: backup customer below the peers, missing relationship, no session, cycle, local-pref order */
cfg = load(EXAMPLE);
Object.assign(remote(cfg, "r10", "50.100.10.4").pref, { mode: "backup", delta: 150 });
assert.ok(lint(cfg).some(t => /^warning: r10 neighbor 50.100.10.4: the backup customer link gets local-preference 150, not above the peers \(200\)/.test(t)));
cfg = load(EXAMPLE);
ctx.setAsRole(cfg.labInfo.bgpAs, "10", "20", "");
ctx.setAsRole(cfg.labInfo.bgpAs, "10", "65000", "customer");
ctx.setAsRole(cfg.labInfo.bgpAs, "100", "1", "provider");
ctx.setAsRole(cfg.labInfo.bgpAs, "1", "10", "customer");
ctx.setAsRole(cfg.labInfo.bgpAs, "1", "100", "provider");	// 100 -> 10 -> 1 -> 100
cfg.labInfo.bgpAs.ases["20"].lp.peer = 50;
const found = lint(cfg);
for (const re of [
	/^warning: AS 10 has eBGP sessions with AS 20 but no relationship with it/,
	/^warning: AS 10 has a relationship with AS 65000 but no eBGP session with it/,
	/^warning: customer-provider cycle: AS 1 is a customer of AS 100 is a customer of AS 10 is a customer of AS 1/,
	/^error: AS 20 prefer-customer: the local-preference must be customer > peer > provider/
]) assert.ok(found.some(t => re.test(t)), re + " not found in:\n" + found.join("\n"));

/* an AS with policy model None: its relationship warnings stay in the AS section, Check Lab is silent */
cfg = load(EXAMPLE);
cfg.labInfo.bgpAs.ases["20"].model = "none";
ctx.setAsRole(cfg.labInfo.bgpAs, "20", "200", "");
ctx.setAsRole(cfg.labInfo.bgpAs, "20", "65000", "peer");
assert.deepEqual(lint(cfg).filter(t => /^warning: AS 20 /.test(t)), []);
assert.ok(lint(cfg).some(t => /^warning: AS 200 has eBGP sessions with AS 20 but no relationship/.test(t)), "AS 200 uses a model: it still warns");
assert.deepEqual(ctx.bgpAsIssues(cfg.netkit, cfg.labInfo.bgpAs).filter(i => i.as == "20" && i.quiet).map(i => i.text), [
	"AS 20 has eBGP sessions with AS 200 but no relationship with it: the policy models ignore them",
	"AS 20 has a relationship with AS 65000 but no eBGP session with it"
]);

/* values from an imported file cannot reach the configuration */
cfg = load(EXAMPLE);
cfg.labInfo.bgpAs.relations.push({ a: "10", b: "3_\nip route 0.0.0.0/0 1.2.3.4", type: "peer" });
assert.ok(!/ip route/.test(conf(cfg, "r10")));

/* quagga uses the same route-maps */
cfg = load(EXAMPLE);
machine(cfg, "r10").routingSoftware = "quagga";
const q = ctx.makeFilesStructure(cfg.netkit, cfg.labInfo).file["r10/etc/zebra/bgpd.conf"];
assert.ok(q.includes("ip as-path access-list NON-CUSTOMER-ROUTES permit ^20_") && q.includes("\tneighbor 50.10.1.2 route-map AS1-OUT out"));

/* configurations exported before AS relationships existed */
for (const old of ["examples/example_lab.config", "examples/example_bgp_policies.config"]) {
	cfg = load(old);
	assert.deepEqual(cfg.labInfo.bgpAs, { relations: [], ases: {} });
	assert.ok(cfg.netkit.every(m => m.routing.bgp.remote.every(r => r.pref.mode == "normal" && r.auto.in == "")));
}

console.log("bgp-as-check: all checks passed");
