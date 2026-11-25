// Checks loopbacks, iBGP over loopbacks, the eBGP-only redistribution into the IGP and Routing Mode. Run: node tests/routing-check.js
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");

const root = path.join(__dirname, "..");
const ctx = { console, window: {}, document: { getElementById: () => ({ classList: { add() {}, remove() {} } }) } };
vm.createContext(ctx);
vm.runInContext("JSON.clone = o => JSON.parse(JSON.stringify(o))", ctx);
for (const f of ["helper.js", "bgp-policy.js", "bgp-as.js", "lint.js", "models/model.js", "make.js", "routing-sim.js"])
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

/* Check Lab */
{
	assert.deepEqual(lint(transit()), [], "the transit lab has no problems");
	const expect = function (mutate, re) {
		const l = transit();
		mutate(l);
		const found = lint(l);
		assert.ok(found.some(t => re.test(t)), re + " not found in:\n" + found.join("\n"));
	};
	const b1 = l => machine(l, "b1"), ibgp = l => b1(l).routing.bgp.remote[1];

	// loopback
	expect(l => b1(l).routing.loopback.ip = "1.1.1", /^error: b1: loopback '1.1.1' is not an address/);
	expect(l => b1(l).routing.loopback.ip = "2.2.2.2", /^error: address 2.2.2.2 is used more than once: b1 lo:0, b2 lo:0/);
	expect(l => b1(l).routing.loopback.ip = "100.0.1.1", /^error: address 100.0.1.1 is used more than once: b1 eth1, b1 lo:0/);
	expect(l => b1(l).routing.rip.connected = false, /^warning: b1: the loopback 1.1.1.1 is used for iBGP by b1 \(neighbor 2.2.2.2\), b2 but no rip\/ospf network contains it and there is no redistribute connected/);
	{	// a network statement or the free text carry it too
		const l = transit();
		Object.assign(b1(l).routing.rip, { connected: false, network: ["100.0.0.0/8", "1.1.1.1/32"] });
		assert.ok(!lint(l).some(t => /loopback 1.1.1.1 is used/.test(t)));
		Object.assign(b1(l).routing.rip, { network: ["100.0.0.0/8"], free: "\tnetwork 1.1.1.1/32" });
		assert.ok(!lint(l).some(t => /loopback 1.1.1.1 is used/.test(t)));
	}
	expect(l => b1(l).routing.rip.en = false, /^warning: b1: the loopback 1.1.1.1 is used for iBGP by .* b1 runs no RIP\/OSPF/);

	// iBGP over loopbacks
	expect(l => ibgp(l).neighbor = "9.9.9.9", /^error: b1 neighbor 9.9.9.9: no machine has this address \(it is not the loopback of any router\)/);
	expect(l => b1(l).routing.loopback.en = false, /^error: b1 neighbor 2.2.2.2: Peer via loopback, but b1 has no loopback/);
	expect(l => b1(l).routing.loopback.en = false, /^error: b1 neighbor 2.2.2.2: update-source 1.1.1.1 is not an address of b1/);
	expect(l => ibgp(l).neighbor = "100.0.2.1", /^warning: b1 neighbor 100.0.2.1: Peer via loopback, but 100.0.2.1 is b2 eth1, not a loopback/);
	expect(l => machine(l, "b2").routing.bgp.remote.pop(), /^error: b1 neighbor 2.2.2.2: b2 has no neighbor statement for b1, the session does not come up/);
	expect(l => ibgp(l).nextHopSelf = false, /^warning: b1 neighbor 2.2.2.2: iBGP session between loopbacks without next-hop-self/);
	{	// next-hop-self in the free text, or no eBGP neighbor: nothing to say
		const l = transit();
		ibgp(l).nextHopSelf = false;
		b1(l).routing.bgp.free = "\tneighbor 2.2.2.2 next-hop-self";
		assert.ok(!lint(l).some(t => /next-hop-self/.test(t)));
	}

	// route-maps of the redistribute statements
	const rm = { id: 41, type: "route-map", name: "lp", rules: [{ seq: 10, action: "permit", matches: [], sets: [{ set: "local-preference", value: "200" }, { set: "metric-type", value: "type-1" }] }] };
	expect(l => Object.assign(b1(l).routing.rip.rmap, { connected: 999 }), /^error: b1 rip redistribute connected: the route-map no longer exists, the statement is not generated/);
	expect(function (l) {
		machine(l, "b2").routing.bgp.policies.push(JSON.parse(JSON.stringify(rm)));
		b1(l).routing.rip.rmap.connected = 41;
	}, /^error: b1 rip redistribute connected: the route-map lp belongs to b2 \(a router uses only its own policies\)/);
	expect(function (l) {
		b1(l).routing.bgp.policies.push(JSON.parse(JSON.stringify(rm)));
		b1(l).routing.rip.rmap.connected = 41;
	}, /^warning: b1 rip redistribute connected: route-map lp has set local-preference, set metric-type, which RIP does not use/);
	{	// policies are checked without BGP too
		const l = transit();
		machine(l, "i1").routing.bgp.policies.push({ id: 42, type: "prefix-list", name: "bad name", rules: [] });
		assert.ok(lint(l).some(t => /^error: i1 prefix-list bad name: name required/.test(t)));
	}

	// eBGP-only redistribution
	expect(l => b1(l).routing.rip.bgp = true, /^warning: b1 eBGP-only redistribution: the plain redistribute bgp of rip is replaced/);
	expect(l => b1(l).routing.rip.free = "redistribute bgp", /^warning: b1 eBGP-only redistribution: the rip free text already has redistribute bgp/);
	expect(l => b1(l).routing.bgp.remote[0].neighbor = "70.0.0.1", /^warning: b1 eBGP-only redistribution: no peering LAN: nothing is generated/);
	expect(l => b1(l).routing.bgp.policies.push({ id: 43, type: "route-map", name: "eBGP", rules: [] }), /^warning: b1 eBGP-only redistribution: there is already a route-map called eBGP with other rules/);
	expect(function (l) {
		const i1 = machine(l, "i1");
		Object.assign(i1.routing.bgp, { en: true, as: "100", remote: [Object.assign({}, b1(l).routing.bgp.remote[1], { neighbor: "1.1.1.1", updateSource: "" })] });
		b1(l).routing.bgp.remote.push(Object.assign({}, b1(l).routing.bgp.remote[1], { neighbor: "100.0.1.2", updateSource: "", loopback: false, nextHopSelf: false }));
		i1.routing.rip.bgp = true;
	}, /^warning: i1: rip redistributes bgp, but i1 has no eBGP neighbor: the eBGP-only redistribution does nothing and every BGP route \(iBGP too\) goes into the IGP/);
}

/* Routing Mode */
const nb = (ip, as, o) => Object.assign(JSON.parse(JSON.stringify(ctx.backbone.routing.bgp.remote[0])), { neighbor: ip, as: String(as) }, o || {});
const trace = (l, src, dst) => ctx.routingSimTrace(ctx.routingSimulate(l.netkit, l.labInfo.bgpAs), src, ctx.parseIp(dst));
const hops = t => t.hops.map(h => h.m + " " + h.code).join(", ") + (t.delivered ? " > " + t.end : " FAIL " + t.fail);
const session = (sim, a, b) => sim.sessions.find(s => s.ends.length == 2 && s.ends.some(e => e.r.name == a) && s.ends.some(e => e.r.name == b));

// iBGP over loopbacks with next-hop-self: IGP hops to the border router, then eBGP
{
	const l = transit(), sim = ctx.routingSimulate(l.netkit, l.labInfo.bgpAs);
	assert.ok(sim.sessions.every(s => s.up), sim.sessions.map(s => s.label + ": " + s.why).join("\n"));
	const r = sim.byName.b1.best["20.1.0.0/24"];
	assert.equal(ctx.ipToString(r.nh), "2.2.2.2", "next-hop-self: the loopback of b2");
	assert.equal(hops(trace(l, "x1", "20.1.0.1")), "x1 B-ext, b1 R, i1 R, b2 B-ext > x2");
	const t = trace(l, "x1", "20.1.0.1");
	assert.equal(t.hops[1].ad, 120);
	assert.match(t.hops[1].reason, /RIP route, metric 3 \(from b2, redistributed bgp there \(route-map eBGP seq 10\)\)/);
	assert.ok(!t.hops.some(h => h.pitfall), "same exit: no pitfall");
	assert.equal(hops(trace(l, "x2", "1.1.1.1")), "x2 B-ext, b2 R, i1 R > b1", "the loopbacks are announced in BGP and carried by RIP");
	// router-id: the loopback
	assert.equal(ctx.ipToString(ctx.simRouterId(sim.byName.b1)), "1.1.1.1");
	// the routing table of b1: RIP (120) selected over iBGP (200)
	const rib = ctx.routingSimRib(sim, "b1").rows.find(x => x.prefix == "20.1.0.0/24").routes.map(x => (x.selected ? ">" : " ") + x.code + " " + x.ad);
	assert.deepEqual(rib, [">R 120", " B-int 200"]);
}
// the IGP does not carry a loopback: the session stays down and says why
{
	const l = transit();
	machine(l, "b2").routing.rip.connected = false;
	const sim = ctx.routingSimulate(l.netkit, l.labInfo.bgpAs), s = session(sim, "b1", "b2");
	assert.ok(!s.up);
	assert.match(s.why, /has no route (back )?to 2.2.2.2.*a loopback: does the IGP carry it\?/);
	const reach = ctx.routingSimReachability(sim);
	// reachability: b2's subnets are not in RIP, x2 reaches AS 100 but the replies to 60.2.0.1 are lost
	assert.deepEqual([reach.count, reach.total], [{ ok: 31, oneway: 3, fail: 14 }, 48]);
	const cell = (from, ip) => reach.rows.find(r => r.m == from).cells[reach.cols.findIndex(c => c.label == ip)];
	assert.equal(cell("x2", "100.0.1.2").text, "x2 \u2192 i1 eth0 100.0.1.2: delivered, the reply to 60.2.0.1 is lost: i1 has no route to 60.2.0.1");
	assert.equal(cell("b1", "2.2.2.2").status, "fail");
	assert.equal(cell("b2", "2.2.2.2").status, "self");
}

// eBGP-only redistribution: the iBGP routes are not redistributed
{
	const l = transit();
	machine(l, "b2").routing.bgp.ebgpToIgp = false;	// b2 does not put 20.1.0.0/24 into RIP: b1 uses its iBGP route
	let sim = ctx.routingSimulate(l.netkit, l.labInfo.bgpAs);
	assert.equal(sim.byName.b1.fib["20.1.0.0/24"].type, "ibgp");
	const note = ctx.routingSimRib(sim, "b1").redist.find(r => r.prefix == "20.1.0.0/24");
	assert.ok(note && !note.ok && note.code == "B-int", "denied by the route-map");
	assert.match(note.text, /route-map eBGP .*no entry matches/);
	assert.ok(!sim.byName.i1.igp.rip["20.1.0.0/24"], "i1 does not learn it");
	assert.match(hops(trace(l, "i1", "20.1.0.1")), /FAIL i1 has no route to 20.1.0.1/);
	// the plain redistribute bgp puts the iBGP route into RIP: i1 sends it to b1, which sends it back to i1
	Object.assign(machine(l, "b1").routing.bgp, { ebgpToIgp: false });
	machine(l, "b1").routing.rip.bgp = true;
	sim = ctx.routingSimulate(l.netkit, l.labInfo.bgpAs);
	assert.equal(sim.byName.i1.igp.rip["20.1.0.0/24"].origin, "b1");
	assert.match(hops(trace(l, "i1", "20.1.0.1")), /^i1 R, b1 B-int FAIL forwarding loop at i1/);
}

// the administrative-distance pitfall: b1 chooses the exit b3 in BGP, but RIP (from b2) wins in its routing table
{
	const l = transit(), b1 = machine(l, "b1"), b2 = machine(l, "b2");
	const l3 = lab({
		b3: { ifs: [["P3", "60.3.0.2/24"], ["L3", "100.0.3.1/24"]], lo: "3.3.3.3", rip: ["100.0.0.0/8"], connected: true, as: 100, networks: ["100.0.0.0/8"],
			nb: [["60.3.0.1", 20], ["1.1.1.1", 100, { updateSource: "3.3.3.3", nextHopSelf: true }], ["2.2.2.2", 100, { updateSource: "3.3.3.3", nextHopSelf: true }]] },
		x3: { ifs: [["P3", "60.3.0.1/24"], ["N3", "20.1.0.3/24"]], as: 20, networks: ["20.1.0.0/24"], nb: [["60.3.0.2", 100]] }
	});
	l3.netkit[0].routing.bgp.ebgpToIgp = false;	// b3 does not redistribute into RIP
	b1.interfaces.if.push({ eth: { number: 2, domain: "L3" }, ip: "100.0.3.2/24" });
	b1.routing.bgp.remote.push(nb("3.3.3.3", 100, { updateSource: "1.1.1.1", nextHopSelf: true }));
	b2.routing.bgp.remote.push(nb("3.3.3.3", 100, { updateSource: "2.2.2.2", nextHopSelf: true }));
	l.netkit.push(...l3.netkit);
	const sim = ctx.routingSimulate(l.netkit, l.labInfo.bgpAs);
	assert.equal(ctx.ipToString(sim.byName.b1.best["20.1.0.0/24"].nh), "3.3.3.3", "BGP: b3 is closer");
	const t = ctx.routingSimTrace(sim, "x1", ctx.parseIp("20.1.0.1"));
	assert.equal(hops(t), "x1 B-ext, b1 R, i1 R, b2 B-ext > x2");
	assert.equal(t.hops[1].pitfall, "RIP (AD 120, from b2, redistributed bgp there (route-map eBGP seq 10)) beats iBGP (AD 200): BGP chose the exit b3 (next hop 3.3.3.3), the packets go towards b2 instead");
	assert.equal(ctx.routingSimRib(sim, "b1").rows.find(x => x.prefix == "20.1.0.0/24").pitfall, t.hops[1].pitfall);
}

/* examples/example_routing.config: every router reaches every address, there and back */
{
	const text = fs.readFileSync(path.join(root, "examples/example_routing.config"), "latin1");
	const l = JSON.parse(text.substring(text.indexOf("[")))[0];
	l.netkit.forEach(ctx.migrateBgpPolicies);
	ctx.migrateBgpAs(l.labInfo);
	assert.deepEqual(lint(l), [], "Check Lab finds nothing in the example");
	const f = files(l);
	assert.ok(f["a1.startup"].includes("ip address add 1.1.1.1/32 dev lo:0\n"));
	assert.ok(f["a1/etc/frr/frr.conf"].includes("\tredistribute connected\n\tredistribute bgp route-map eBGP\n"));
	assert.ok(f["b1/etc/frr/frr.conf"].includes("\tredistribute connected route-map connected-e1\n\tredistribute bgp route-map eBGP\n"));
	assert.ok(f["b1/etc/frr/frr.conf"].includes("\tneighbor 2.2.2.2 remote-as 200\n\tneighbor 2.2.2.2 update-source 2.2.2.1\n\tneighbor 2.2.2.2 next-hop-self\n\tneighbor 2.2.2.2 description router b2 (iBGP)\n"));
	const sim = ctx.routingSimulate(l.netkit, l.labInfo.bgpAs);
	assert.ok(sim.converged && sim.sessions.every(s => s.up), sim.sessions.map(s => s.label + ": " + s.why).join("\n"));
	const reach = ctx.routingSimReachability(sim), bad = [].concat(...reach.rows.map(r => r.cells)).filter(c => c.status == "oneway" || c.status == "fail");
	assert.deepEqual(bad.map(c => c.text), [], "every machine pings every address");
	assert.equal(reach.total, 252);
	// AS 10 to AS 20: RIP across AS 100 (a1 a2 a5, 2 hops), OSPF across AS 200 around the expensive b1-b2 link
	assert.equal(hops(ctx.routingSimTrace(sim, "s10", ctx.parseIp("20.20.20.1"))), "s10 B-ext, a1 R, a2 R, a5 B-ext, b1 O, b3 O, b2 B-ext > s20");
	// quagga: an ospf cost only on eth2 leaves null entries in ospf.if (as the form does)
	l.netkit.forEach(m => m.routingSoftware = "quagga");
	const q = files(l)["b1/etc/zebra/ospfd.conf"];
	assert.ok(q.includes("\tredistribute connected route-map connected-e1\n") && q.includes("route-map eBGP permit 10\n") && q.includes("interface eth2\n\tospf cost 50\n"));
}

// anycast: h1 and h2 both have 20.0.0.2 (as in the Nefertiti exam lab); a ping is delivered to the nearest one and
// so is the reply, which may not be the machine that sent the request
{
	const l = lab({
		r1: { ifs: [["A", "20.0.0.1/24"], ["B", "30.0.0.1/24"]], rip: ["20.0.0.0/8", "30.0.0.0/8"] },
		r2: { ifs: [["B", "30.0.0.2/24"], ["C", "40.0.0.1/24"]], rip: ["30.0.0.0/8", "40.0.0.0/8"] },
		r4: { ifs: [["C", "40.0.0.2/24"], ["D", "50.0.0.1/24"]], rip: ["40.0.0.0/8", "50.0.0.0/8"] },
		r3: { ifs: [["D", "50.0.0.2/24"], ["H", "20.0.0.3/24"]], rip: ["50.0.0.0/8", "20.0.0.0/8"] }
	});
	for (const [name, domain, gw] of [["h1", "A", "20.0.0.1"], ["h2", "H", "20.0.0.3"]]) {
		const m = JSON.parse(JSON.stringify(ctx.backbone));
		Object.assign(m, { name: name, row: l.netkit.length + 1 });
		m.interfaces.if = [{ eth: { number: 0, domain: domain }, ip: "20.0.0.2/24" }];
		m.gateways.gw = [{ route: "", gw: gw, if: 0 }];
		l.netkit.push(m);
	}
	const sim = ctx.routingSimulate(l.netkit, l.labInfo.bgpAs), reach = ctx.routingSimReachability(sim);
	const cell = (from, m, ip) => reach.rows.find(r => r.m == from).cells[reach.cols.findIndex(c => c.m == m && c.label == ip)];
	assert.equal(hops(ctx.routingSimTrace(sim, "r4", ctx.parseIp("20.0.0.2"))), "r4 R, r3 C > h2");
	assert.equal(cell("r2", "h2", "20.0.0.2").status, "ok");
	assert.match(cell("r2", "h2", "20.0.0.2").text, /delivered to h1 \(anycast: 20.0.0.2 is also on h1\)/);
	assert.equal(cell("h1", "r4", "40.0.0.2").status, "oneway");
	assert.match(cell("h1", "r4", "40.0.0.2").text, /the reply to 20.0.0.2 goes to h2 instead/);
	assert.equal(cell("h1", "r2", "40.0.0.1").status, "ok");
	assert.equal(cell("h1", "h2", "20.0.0.2").status, "self");
	assert.equal(cell("h1", "r3", "20.0.0.3").status, "fail", "20.0.0.3 is on H, not on the LAN of h1");
	// checked on the running Nefertiti lab: ws2 ping 20.0.0.1 leaves the neighbor INCOMPLETE, r1 sees no packet
	assert.match(cell("h1", "r3", "20.0.0.3").text, /h1 sends an ARP request there that gets no answer, 20.0.0.3 is on r3 in collision domain H$/);
}

console.log("routing-check: all checks passed");
