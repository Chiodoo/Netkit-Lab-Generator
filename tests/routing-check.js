// Checks loopbacks, iBGP over loopbacks and the eBGP-only redistribution into the IGP. Run: node tests/routing-check.js
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");

const root = path.join(__dirname, "..");
const ctx = { console, window: {}, document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) } };
vm.createContext(ctx);
vm.runInContext("JSON.clone = o => JSON.parse(JSON.stringify(o))", ctx);
for (const f of ["helper.js", "bgp-policy.js", "bgp-as.js", "lint.js", "models/model.js", "make.js"])
	vm.runInContext(fs.readFileSync(path.join(root, "src/lab-generator", f), "utf8"), ctx, { filename: f });

// routers: { name: { ifs: [[domain, cidr], ...], lo, rip: [networks], ospf: [networks, area 0], connected (redistribute into the IGP),
// as, networks, nb: [[ip, as, { description, updateSource, nextHopSelf }]] } }, built like the UI (new machines)
function lab(routers) {
	const netkit = Object.keys(routers).map(function (name, row) {
		const s = routers[name], m = JSON.parse(JSON.stringify(ctx.backbone));
		Object.assign(m, { name: name, type: "router", row: row + 1 });
		m.interfaces.if = s.ifs.map((x, i) => ({ eth: { number: i, domain: x[0] }, ip: x[1] }));
		if (s.lo) m.routing.loopback = { en: true, ip: s.lo };
		if (s.rip) Object.assign(m.routing.rip, { en: true, network: s.rip, connected: !!s.connected });
		if (s.ospf) Object.assign(m.routing.ospf, { en: true, network: s.ospf, area: s.ospf.map(() => "0.0.0.0"), stub: s.ospf.map(() => false), connected: !!s.connected });
		if (s.as) {
			Object.assign(m.routing.bgp, { en: true, as: String(s.as), noEbgpRequiresPolicy: true, noNetworkImportCheck: true, network: s.networks || [] });
			m.routing.bgp.remote = (s.nb || []).map(n => Object.assign(JSON.parse(JSON.stringify(ctx.backbone.routing.bgp.remote[0])), { neighbor: n[0], as: String(n[1]) }, n[2] || {}));
		}
		return m;
	});
	return { netkit: netkit, labInfo: JSON.parse(JSON.stringify(ctx.labInfo)) };
}
const files = l => ctx.makeFilesStructure(l.netkit, l.labInfo).file;
const conf = (l, name) => files(l)[name + "/etc/frr/frr.conf"];
const machine = (l, name) => l.netkit.find(m => m.name == name);
const lint = l => ctx.lintLab(l.netkit, l.labInfo.bgpAs).map(i => i.level + ": " + i.text);

// a transit AS 100 with RIP between two border routers that peer iBGP over their loopbacks (the pattern of the course labs)
const transit = () => lab({
	x1: { ifs: [["P1", "60.1.0.1/24"], ["N1", "10.1.0.1/24"]], as: 10, networks: ["10.1.0.0/24"], nb: [["60.1.0.2", 100]] },
	b1: { ifs: [["P1", "60.1.0.2/24"], ["L1", "100.0.1.1/24"]], lo: "1.1.1.1", rip: ["100.0.0.0/8"], connected: true,
		as: 100, networks: ["100.0.0.0/8", "1.1.1.1/32", "60.1.0.0/24"],
		nb: [["60.1.0.1", 10], ["2.2.2.2", 100, { description: "router b2 (iBGP)", updateSource: "1.1.1.1", nextHopSelf: true, loopback: true }]] },
	i1: { ifs: [["L1", "100.0.1.2/24"], ["L2", "100.0.2.2/24"]], rip: ["100.0.0.0/8"] },
	b2: { ifs: [["P2", "60.2.0.2/24"], ["L2", "100.0.2.1/24"]], lo: "2.2.2.2", rip: ["100.0.0.0/8"], connected: true,
		as: 100, networks: ["100.0.0.0/8", "2.2.2.2/32", "60.2.0.0/24"],
		nb: [["60.2.0.1", 20], ["1.1.1.1", 100, { description: "router b1 (iBGP)", updateSource: "2.2.2.2", nextHopSelf: true, loopback: true }]] },
	x2: { ifs: [["P2", "60.2.0.1/24"], ["N2", "20.1.0.1/24"]], as: 20, networks: ["20.1.0.0/24"], nb: [["60.2.0.2", 100]] }
});

/* eBGP-only redistribution: on for new border routers, the lines of the course labs */
{
	const l = transit();
	assert.equal(machine(l, "b1").routing.bgp.ebgpToIgp, true, "on for new routers");
	const b1 = conf(l, "b1");
	assert.ok(b1.includes("router rip\n\tnetwork 100.0.0.0/8\n\tredistribute connected\n\tredistribute bgp route-map eBGP\n\n"), b1);
	assert.ok(b1.includes("!\n\nip prefix-list myNeighbors seq 5 permit 60.1.0.0/24 le 32\n!\n\nroute-map eBGP permit 10\n\tmatch ip next-hop prefix-list myNeighbors\n!\n\nlog file"), b1);
	assert.ok(conf(l, "b2").includes("ip prefix-list myNeighbors seq 5 permit 60.2.0.0/24 le 32"));
	// not a border router (no eBGP neighbor) or no IGP: nothing
	assert.ok(!/eBGP|myNeighbors/.test(conf(l, "i1") + conf(l, "x1")));
	const red = ctx.ebgpRedistribution(machine(l, "b1"));
	assert.ok(red.applicable && red.active && !red.notes.length);
	assert.deepEqual(red.igps, ["rip"]);

	// one entry per peering LAN, seq 5, 10, ...
	machine(l, "b1").interfaces.if.push({ eth: { number: 2, domain: "P3" }, ip: "60.3.0.2/30" });
	machine(l, "b1").routing.bgp.remote.push(Object.assign({}, machine(l, "b1").routing.bgp.remote[0], { neighbor: "60.3.0.1", as: "30" }));
	machine(l, "b1").routing.bgp.remote.push(Object.assign({}, machine(l, "b1").routing.bgp.remote[0], { neighbor: "60.1.0.9", as: "11" }));
	assert.ok(conf(l, "b1").includes("ip prefix-list myNeighbors seq 5 permit 60.1.0.0/24 le 32\nip prefix-list myNeighbors seq 10 permit 60.3.0.0/30 le 32\n!"));
	// a neighbor not on an interface subnet: warned
	machine(l, "b1").routing.bgp.remote.push(Object.assign({}, machine(l, "b1").routing.bgp.remote[0], { neighbor: "70.0.0.1", as: "40" }));
	assert.match(ctx.ebgpRedistribution(machine(l, "b1")).notes.join(), /70.0.0.1 is not on the subnet of an interface/);

	// RIP and OSPF: both get it; quagga: in ripd.conf/ospfd.conf with the definitions
	const b2 = machine(l, "b2");
	Object.assign(b2.routing.ospf, { en: true, network: ["100.0.0.0/8"] });
	assert.equal(conf(l, "b2").match(/redistribute bgp route-map eBGP/g).length, 2);
	b2.routingSoftware = "quagga";
	const q = files(l);
	for (const d of ["ripd", "ospfd"]) assert.match(q["b2/etc/zebra/" + d + ".conf"], /\tredistribute bgp route-map eBGP\n!\n\nip prefix-list myNeighbors seq 5 permit 60.2.0.0\/24 le 32\n!\n\nroute-map eBGP permit 10\n\tmatch ip next-hop prefix-list myNeighbors\n!\n/);
	assert.match(q["b2/etc/zebra/bgpd.conf"], /route-map eBGP permit 10/);
}

/* off: configurations exported before it existed, or unticked */
{
	const l = transit();
	const old = JSON.parse(JSON.stringify(l.netkit));
	old.forEach(m => delete m.routing.bgp.ebgpToIgp);
	old.forEach(ctx.migrateBgpPolicies);
	assert.equal(old[1].routing.bgp.ebgpToIgp, false);
	assert.ok(!/eBGP|myNeighbors/.test(files({ netkit: old, labInfo: l.labInfo })["b1/etc/frr/frr.conf"]));
	machine(l, "b1").routing.bgp.ebgpToIgp = false;
	machine(l, "b1").routing.rip.bgp = true;
	assert.ok(conf(l, "b1").includes("\tredistribute bgp\n") && !conf(l, "b1").includes("myNeighbors"));
}

/* manual redistribute bgp: never twice */
{
	let l = transit(), b1 = machine(l, "b1");
	b1.routing.rip.bgp = true;	// plain: replaced
	assert.equal(conf(l, "b1").match(/redistribute bgp/g).length, 1);
	assert.match(ctx.ebgpRedistribution(b1).notes.join(), /plain redistribute bgp of rip is replaced/);
	b1.routing.bgp.policies.push({ id: 5, type: "route-map", name: "mine", rules: [{ seq: 10, action: "permit", matches: [], sets: [] }] });
	b1.routing.rip.rmap = { bgp: 5 };	// with a route-map chosen by hand: kept
	assert.ok(conf(l, "b1").includes("\tredistribute bgp route-map mine\n") && !conf(l, "b1").includes("eBGP"));
	assert.match(ctx.ebgpRedistribution(b1).notes.join(), /route-map mine, chosen by hand/);
	l = transit(); b1 = machine(l, "b1");
	b1.routing.rip.free = "\tredistribute bgp metric 3";	// in the free text: not added
	assert.equal(conf(l, "b1").match(/redistribute bgp/g).length, 1);
	assert.match(ctx.ebgpRedistribution(b1).notes.join(), /free text already has redistribute bgp/);
}

/* name clashes: same rules reused, other rules -> -AUTO */
{
	let l = transit(), b1 = machine(l, "b1");
	b1.routing.bgp.policies.push({ id: 7, type: "prefix-list", name: "myNeighbors", rules: [{ seq: 5, action: "permit", prefix: "60.1.0.0/24", ge: null, le: 32 }] });
	assert.equal(conf(l, "b1").match(/ip prefix-list myNeighbors/g).length, 1, "twin reused, not defined twice");
	assert.equal(ctx.ebgpRedistribution(b1).notes.length, 0);
	b1.routing.bgp.policies[0].rules[0].prefix = "60.9.0.0/24";
	b1.routing.bgp.policies.push({ id: 8, type: "route-map", name: "eBGP", rules: [] });
	const c = conf(l, "b1");
	assert.ok(c.includes("ip prefix-list myNeighbors-AUTO seq 5 permit 60.1.0.0/24 le 32") && c.includes("ip prefix-list myNeighbors seq 5 permit 60.9.0.0/24"));
	assert.ok(c.includes("\tredistribute bgp route-map eBGP-AUTO\n") && c.includes("route-map eBGP-AUTO permit 10\n\tmatch ip next-hop prefix-list myNeighbors-AUTO\n"));
	assert.equal(ctx.ebgpRedistribution(b1).notes.filter(n => /-AUTO/.test(n)).length, 2);
}

console.log("routing-check: all checks passed");
