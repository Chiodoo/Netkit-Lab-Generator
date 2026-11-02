// Checks the "Check Lab" linter. Run: node tests/lab-lint-check.js
const fs = require("fs"), vm = require("vm"), assert = require("assert"), path = require("path");

const root = path.join(__dirname, "..");
const ctx = { console };
vm.createContext(ctx);
for (const f of ["bgp-policy.js", "models/model.js", "lint.js"])
	vm.runInContext(fs.readFileSync(path.join(root, "src/lab-generator", f), "utf8"), ctx, { filename: f });

function load() {
	const text = fs.readFileSync(path.join(root, "examples/example_bgp_policies.config"), "latin1");
	const netkit = JSON.parse(text.substring(text.indexOf("[")))[0].netkit;
	netkit.forEach(ctx.migrateBgpPolicies);
	return netkit;
}
const lint = netkit => ctx.lintLab(netkit).map(i => i.level + ": " + i.text);
const machine = (netkit, name) => netkit.find(m => m.name == name);
function expect(mutate, re) {
	const netkit = load();
	mutate(netkit);
	const found = lint(netkit);
	assert.ok(found.some(t => re.test(t)), re + " not found in:\n" + found.join("\n"));
}

assert.deepEqual(lint(load()), [], "the example has no problems");

/* addresses */
expect(n => machine(n, "r1").interfaces.if[1].ip = "50.1.2.0/24", /^error: r1 eth1: 50.1.2.0\/24 is the network address, use a host address like 50.1.2.1\/24/);
expect(n => machine(n, "r1").interfaces.if[1].ip = "50.1.2.255/24", /^error: r1 eth1: .* broadcast/);
expect(n => machine(n, "r1").interfaces.if[1].ip = "50.1.2.1", /^error: r1 eth1: '50.1.2.1' is not an address/);
expect(n => machine(n, "r1").interfaces.if[1].ip = "50.1.2.2/24", /^error: address 50.1.2.2 is used more than once: r1 eth1, r2 eth0/);
expect(n => machine(n, "r1").interfaces.if[1].ip = "50.1.3.1/24", /^error: collision domain G mixes different subnets/);
expect(n => machine(n, "r1").interfaces.if[1].eth.domain = "", /^error: r1 eth1: no collision domain/);
expect(n => machine(n, "r1").interfaces.if[1].eth.domain = "g", /^warning: collision domains G and g differ only in case/);

/* BGP neighbors */
expect(n => machine(n, "r1").routing.bgp.remote[1].neighbor = "50.1.2.3", /^error: r1 neighbor 50.1.2.3: no machine has this address/);
expect(n => machine(n, "r1").routing.bgp.remote[1].as = "3", /^error: r1 neighbor 50.1.2.2 is r2 eth0 in AS 2, not AS 3/);
expect(n => machine(n, "r1").routing.bgp.remote[1].as = "", /^error: r1 neighbor 50.1.2.2: no remote-as/);
expect(n => machine(n, "r2").routing.bgp.remote[0].neighbor = "", /^error: r1 neighbor 50.1.2.2: r2 has no neighbor statement for r1 \(50.1.2.1\)/);
expect(n => machine(n, "r2").routing.bgp.remote[0].neighbor = "50.1.10.1", /^warning: r1 neighbor 50.1.2.2: r2 peers with 50.1.10.1, but r1 reaches it from 50.1.2.1/);
expect(n => machine(n, "r2").routing.bgp.en = false, /^error: r1 neighbor 50.1.2.2 is r2 eth0, which does not run BGP/);
expect(n => machine(n, "r1").routing.bgp.remote[1].neighbor = "50.2.20.2", /^warning: r1 neighbor 50.2.20.2 .* needs ebgp-multihop/);
expect(n => {
	const b03 = machine(n, "b03").routing.bgp;
	b03.noEbgpRequiresPolicy = false;
	b03.remote[0].apply["route-map"].out = b03.remote[0].apply["distribute-list"].out = null;
}, /^warning: b03 neighbor 50.2.88.2: eBGP without out policy, FRR \(ebgp-requires-policy\) announces nothing to it/);
expect(n => machine(n, "r1").routing.bgp.noEbgpRequiresPolicy = false, /^warning: r1 neighbor 50.1.2.2: eBGP without in\/out policy/);
expect(n => machine(n, "r1").routing.bgp.network[0] = "100.1.0.1/16", /^error: r1 bgp network: 100.1.0.1\/16 has host bits set, did you mean 100.1.0.0\/16\?/);
expect(n => machine(n, "r1").routing.bgp.as = "", /^error: r1: the AS number is missing/);

/* interfaces that do not exist */
expect(n => machine(n, "r1").gateways.gw[0] = { route: "", gw: "50.1.2.2", if: 7 }, /^error: r1 route default via 50.1.2.2: eth7 is not declared/);
expect(n => machine(n, "r1").gateways.gw[0] = { route: "", gw: "50.1.2.2", if: 2 }, /^error: r1 route default via 50.1.2.2: 50.1.2.2 is not in the subnet of eth2/);
expect(n => machine(n, "r1").gateways.gw[0] = { route: "", gw: "50.1.2.9", if: 1 }, /^error: r1 route default via 50.1.2.9: no machine has the address/);
expect(n => Object.assign(machine(n, "r1").routing.ospf, { en: true, network: ["50.1.2.0/24"], if: [{ interface: 5, cost: 10 }] }),
	/^error: r1: ospf cost on eth5, which is not declared/);
expect(n => Object.assign(machine(n, "r1").routing.ospf, { en: true, network: ["50.1.2.0/24"], if: [{ cost: 10 }] }),
	/^error: r1: ospf cost 10 has no interface chosen/);
expect(n => Object.assign(machine(n, "r1").routing.ospf, { en: true, network: ["60.0.0.0/8"] }),
	/^warning: r1 ospf network 60.0.0.0\/8 contains no interface of r1/);
expect(n => Object.assign(machine(n, "r1").routing.ospf, { en: true, network: ["50.1.2.0/24"], stub: [true] }),
	/^error: r1 ospf network 50.1.2.0\/24: the backbone area 0 cannot be stub/);

/* machines */
expect(n => machine(n, "r2").name = "r1", /^error: r1: two machines have the same name/);
expect(n => machine(n, "r2").name = "", /^error: machine 2: no name, nothing is generated/);

/* addresses added in the startup free text count as existing */
expect(n => {
	machine(n, "r2").interfaces.free = "ip address add 2.2.2.2/32 dev lo";
	machine(n, "r1").routing.bgp.remote[1].neighbor = "2.2.2.2";
}, /^warning: r1 neighbor 2.2.2.2 \(r2 lo\) does not share a collision domain/);

console.log("lab-lint-check: all checks passed");
