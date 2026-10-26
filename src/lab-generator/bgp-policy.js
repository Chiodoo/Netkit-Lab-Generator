/* ---------------------------------------------------------------- */
/* ---------------------- BGP POLICIES ---------------------------- */
/* prefix-lists, access-lists, as-path access-lists and route-maps   */
/* defined per router and applied to its BGP neighbors              */
/* ---------------------------------------------------------------- */

var POLICY_TYPES = [
	{ type: "prefix-list", label: "prefix-list" },
	{ type: "access-list", label: "access-list" },
	{ type: "as-path", label: "as-path access-list" },
	{ type: "route-map", label: "route-map" }
];

// neighbor <ip> <cmd> <name> in|out, and the type of list each command takes
var NEIGHBOR_POLICY_CMDS = [
	{ cmd: "prefix-list", type: "prefix-list" },
	{ cmd: "route-map", type: "route-map" },
	{ cmd: "distribute-list", type: "access-list" },
	{ cmd: "filter-list", type: "as-path" }
];

var ROUTE_MAP_MATCHES = [
	{ match: "ip address prefix-list", type: "prefix-list" },
	{ match: "ip address", type: "access-list" },
	{ match: "as-path", type: "as-path" }
];

var ROUTE_MAP_SETS = [
	{ set: "local-preference", placeholder: "200" },
	{ set: "metric", placeholder: "10" },
	{ set: "as-path prepend", placeholder: "10 10 10" },
	{ set: "community", placeholder: "200:11111" }
];

var MAX_UINT32 = 4294967295;

function emptyApply() {
	let apply = {};
	for (let c of NEIGHBOR_POLICY_CMDS) apply[c.cmd] = { in: null, out: null };
	return apply;
}

// configurations exported before policies existed
function migrateBgpPolicies(machine) {
	let bgp = machine && machine.routing && machine.routing.bgp;
	if (!bgp) return;
	if (!Array.isArray(bgp.policies)) bgp.policies = [];
	for (let remote of bgp.remote || []) {
		if (remote && !remote.apply) remote.apply = emptyApply();
	}
}

/* -------------------- addresses -------------------- */

function parseIp(s) {
	let m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(String(s).trim());
	if (!m) return null;
	let n = 0;
	for (let i = 1; i <= 4; i++) {
		if (+m[i] > 255) return null;
		n = n * 256 + +m[i];
	}
	return n;
}

function ipToString(n) {
	return [n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join(".");
}

function parseCidr(s) {
	let parts = String(s).trim().split("/");
	if (parts.length != 2 || !/^\d{1,2}$/.test(parts[1]) || +parts[1] > 32) return null;
	let addr = parseIp(parts[0]);
	if (addr === null) return null;
	let len = +parts[1];
	let mask = len == 0 ? 0 : (0xFFFFFFFF << (32 - len)) >>> 0;
	return { addr: addr, len: len, net: (addr & mask) >>> 0 };
}

function cidrNetwork(s) {
	let c = parseCidr(s);
	return c && ipToString(c.net) + "/" + c.len;
}

/* -------------------- validation -------------------- */

function hasValue(v) {
	return v !== undefined && v !== null && v !== "";
}

function isUint(v, max) {
	return /^\d+$/.test(String(v)) && +v <= max;
}

function findPolicy(policies, id, type) {
	if (!hasValue(id)) return null;
	return (policies || []).find(p => p.id == id && p.type == type) || null;
}

function policyNameError(policy) {
	return /^[A-Za-z0-9_.-]+$/.test(policy.name || "") ? "" : "name required (letters, digits, _ . - only)";
}

// errors make the generator skip the policy (name) or the rule
function policyError(policies, policy) {
	let err = policyNameError(policy);
	if (err) return err;
	if (policies.filter(p => p.type == policy.type && p.name == policy.name).length > 1)
		return "duplicate name: there is another " + policy.type + " called " + policy.name;
	let seqs = policy.rules.map(r => r.seq).filter(s => hasValue(s));
	let dup = seqs.find((s, i) => seqs.indexOf(s) != i);
	if (dup !== undefined) return "duplicate sequence number " + dup + ": only the last rule with it would be kept";
	return "";
}

function policyWarning(policy) {
	return policy.rules.length ? "" : "no rules: this " + policy.type + " denies everything";
}

function prefixError(prefix) {
	if (prefix == "any") return "";
	let c = parseCidr(prefix || "");
	if (!c) return "prefix must be any or a network like 10.0.0.0/8";
	if (c.addr != c.net) return "host bits set, did you mean " + ipToString(c.net) + "/" + c.len + "?";
	return "";
}

function prefixListRuleError(rule) {
	let err = prefixError(rule.prefix);
	if (err) return err;
	let hasGe = hasValue(rule.ge), hasLe = hasValue(rule.le);
	if (!hasGe && !hasLe) return "";
	if (rule.prefix == "any") return "ge/le cannot be used with any";
	if ((hasGe && !isUint(rule.ge, 32)) || (hasLe && !isUint(rule.le, 32))) return "ge/le must be between 0 and 32";
	let len = parseCidr(rule.prefix).len;
	if (hasGe && +rule.ge <= len) return "ge must be greater than the prefix length /" + len;
	if (hasLe && +rule.le < len) return "le must not be smaller than the prefix length /" + len;
	if (hasGe && hasLe && +rule.ge > +rule.le) return "ge must not be greater than le";
	return "";
}

function setValueError(set) {
	let v = String(set.value || "").trim();
	switch (set.set) {
		case "local-preference":
		case "metric":
			return isUint(v, MAX_UINT32) ? "" : "a number between 0 and " + MAX_UINT32;
		case "as-path prepend":
			return v && v.split(/\s+/).every(t => isUint(t, MAX_UINT32) && +t > 0) ? "" : "one or more AS numbers, e.g. 10 10 10";
		case "community":
			return v && v.split(/\s+/).every(t => /^(no-export|no-advertise|local-AS|internet|additive|none)$/.test(t)
				|| (/^(\d+):(\d+)$/.test(t) && t.split(":").every(n => +n <= 65535))) ? "" : "AA:NN values, e.g. 200:11111";
	}
	return "unknown set";
}

function routeMapRuleError(rule, policies) {
	for (let m of rule.matches) {
		let def = ROUTE_MAP_MATCHES.find(d => d.match == m.match);
		if (!def) return "unknown match";
		if (!findPolicy(policies, m.value, def.type)) return "match " + m.match + ": choose a " + def.type;
	}
	for (let s of rule.sets) {
		let err = setValueError(s);
		if (err) return "set " + s.set + ": " + err;
	}
	return "";
}

function policyRuleError(policies, policy, rule) {
	let maxSeq = policy.type == "route-map" ? 65535 : MAX_UINT32;
	if (!isUint(rule.seq, maxSeq) || +rule.seq < 1) return "sequence number must be between 1 and " + maxSeq;
	if (rule.action != "permit" && rule.action != "deny") return "choose permit or deny";
	switch (policy.type) {
		case "prefix-list": return prefixListRuleError(rule);
		case "access-list": return prefixError(rule.prefix);
		case "as-path": return !rule.regex ? "regular expression required" : /'/.test(rule.regex) ? "quotes are not allowed" : "";
		case "route-map": return routeMapRuleError(rule, policies);
	}
	return "unknown policy type";
}

function policyRuleWarning(policy, rule) {
	if (policy.type == "route-map" && rule.action == "deny" && rule.sets.length)
		return "set actions are useless in a deny statement: matching announcements are filtered out";
	return "";
}

function neighborPolicyError(remote) {
	let a = remote.apply || {};
	for (let dir of ["in", "out"]) {
		if (a["prefix-list"] && a["prefix-list"][dir] && a["distribute-list"] && a["distribute-list"][dir])
			return "prefix-list and distribute-list cannot be used together in the same direction (" + dir + ")";
	}
	return "";
}

// where a policy is used on its router: deleting it is blocked while this is not empty
function policyReferences(bgp, policy) {
	let refs = [];
	for (let remote of bgp.remote || []) {
		for (let c of NEIGHBOR_POLICY_CMDS) {
			for (let dir of ["in", "out"]) {
				if (c.type == policy.type && remote.apply && remote.apply[c.cmd] && remote.apply[c.cmd][dir] == policy.id)
					refs.push("neighbor " + (remote.neighbor || "(empty)") + " " + c.cmd + " " + dir);
			}
		}
	}
	for (let p of bgp.policies || []) {
		if (p.type != "route-map") continue;
		for (let rule of p.rules) {
			if (rule.matches.some(m => m.value == policy.id)) refs.push("route-map " + p.name + " seq " + rule.seq);
		}
	}
	return refs;
}

/* -------------------- explanations -------------------- */

function policyRuleExplain(policies, policy, rule) {
	if (policyRuleError(policies, policy, rule)) return "";
	let tail = " (" + rule.action + ", seq " + rule.seq + ")";
	switch (policy.type) {
		case "prefix-list": {
			if (rule.prefix == "any") return "Matches any prefix" + tail;
			let len = parseCidr(rule.prefix).len;
			if (!hasValue(rule.ge) && !hasValue(rule.le)) return "Matches exactly " + rule.prefix + tail;
			let from = hasValue(rule.ge) ? +rule.ge : len, to = hasValue(rule.le) ? +rule.le : 32;
			return "Matches prefixes inside " + rule.prefix + " with length "
				+ (from == to ? "/" + from : "from /" + from + " to /" + to) + tail;
		}
		case "access-list":
			if (rule.prefix == "any") return "Matches any prefix" + tail;
			if (rule.exactMatch) return "Matches exactly " + rule.prefix + tail;
			return "Matches " + rule.prefix + " and every more specific prefix inside it" + tail;
		case "as-path":
			return "Matches AS paths matching the regular expression " + rule.regex + tail;
		case "route-map": {
			// same kind of match: OR, different kinds: AND
			let groups = ROUTE_MAP_MATCHES.map(def => rule.matches.filter(m => m.match == def.match)
				.map(m => def.match + " " + findPolicy(policies, m.value, def.type).name).join(" OR "))
				.filter(g => g);
			let what = groups.length ? "Announcements matching " + groups.map(g => groups.length > 1 && g.indexOf(" OR ") > 0 ? "(" + g + ")" : g).join(" AND ") + " are"
				: "Every announcement is";
			if (rule.action == "deny") return what + " filtered out" + tail;
			if (!rule.sets.length) return what + " accepted unchanged" + tail;
			return what + " accepted with " + rule.sets.map(s => s.set + " " + String(s.value).trim()).join(", ") + tail;
		}
	}
	return "";
}

/* -------------------- config generation -------------------- */

function sortedRules(policy) {
	return policy.rules.slice().sort((a, b) => a.seq - b.seq);
}

// inside "router bgp": must follow every "neighbor ... remote-as" statement
function bgpNeighborPolicyLines(bgp) {
	let text = "";
	for (let remote of bgp.remote || []) {
		if (!remote || !remote.neighbor || !remote.as) continue;
		if (remote.defaultOriginate) text += "\tneighbor " + remote.neighbor + " default-originate\n";
		for (let c of NEIGHBOR_POLICY_CMDS) {
			for (let dir of ["in", "out"]) {
				let policy = remote.apply && remote.apply[c.cmd] && findPolicy(bgp.policies, remote.apply[c.cmd][dir], c.type);
				if (policy && !policyNameError(policy))
					text += "\tneighbor " + remote.neighbor + " " + c.cmd + " " + policy.name + " " + dir + "\n";
			}
		}
	}
	return text;
}

function policyRuleLines(policies, policy, rule, quagga) {
	let seq = " seq " + rule.seq;
	switch (policy.type) {
		case "prefix-list":
			return "ip prefix-list " + policy.name + seq + " " + rule.action + " " + rule.prefix
				+ (hasValue(rule.ge) ? " ge " + rule.ge : "") + (hasValue(rule.le) ? " le " + rule.le : "") + "\n";
		case "access-list": // quagga has no seq: the order of the lines is the order of evaluation
			return "access-list " + policy.name + (quagga ? "" : seq) + " " + rule.action + " " + rule.prefix
				+ (rule.exactMatch && rule.prefix != "any" ? " exact-match" : "") + "\n";
		case "as-path":
			return (quagga ? "ip as-path access-list " + policy.name : "bgp as-path access-list " + policy.name + seq)
				+ " " + rule.action + " " + rule.regex + "\n";
		case "route-map":
			return "route-map " + policy.name + " " + rule.action + " " + rule.seq + "\n"
				+ rule.matches.map(m => "\tmatch " + m.match + " "
					+ findPolicy(policies, m.value, ROUTE_MAP_MATCHES.find(d => d.match == m.match).type).name + "\n").join("")
				+ rule.sets.map(s => "\tset " + s.set + " " + String(s.value).trim().split(/\s+/).join(" ") + "\n").join("");
	}
	return "";
}

// outside "router bgp": a definition inside the block would close it and the following bgp commands would be ignored
function bgpPolicyDefinitions(bgp, routingSoftware) {
	let policies = bgp.policies || [], text = "";
	for (let t of POLICY_TYPES) {
		for (let policy of policies.filter(p => p.type == t.type)) {
			text += "!\n";
			let nameErr = policyNameError(policy);
			if (nameErr) {
				text += "! " + policy.type + " skipped: " + nameErr + "\n";
				continue;
			}
			for (let rule of sortedRules(policy)) {
				let err = policyRuleError(policies, policy, rule);
				if (err) text += "! " + policy.type + " " + policy.name + " seq " + rule.seq + " skipped: " + err + "\n";
				else text += policyRuleLines(policies, policy, rule, routingSoftware == "quagga");
			}
		}
	}
	return text ? text + "!\n" : "";
}

/* -------------------- suggestions (avoid typos) -------------------- */

// networks of the lab for <datalist id="lab-networks">, neighbors/gateways of each machine (by index)
function labSuggestions(netkit) {
	let networks = [], seen = {};
	let addNetwork = function (cidr, label) {
		let net = cidr && cidrNetwork(cidr);
		if (net && !seen[net]) {
			seen[net] = true;
			networks.push({ value: net, label: label });
		}
	};
	let ifaces = m => (m.interfaces && m.interfaces.if) || [];
	let asLabel = m => m.type == "router" && m.routing && m.routing.bgp.en && m.routing.bgp.as ? " (AS " + m.routing.bgp.as + ")" : "";

	for (let m of netkit) {
		for (let i of ifaces(m)) {
			if (i.eth.domain && i.eth.domain != "SDNRESERVED") addNetwork(i.ip, "collision domain " + i.eth.domain);
		}
	}
	for (let m of netkit) {
		if (m.type != "router" || !m.routing) continue;
		for (let n of m.routing.bgp.network || []) addNetwork(n, "announced by " + m.name);
		for (let n of m.routing.rip.network || []) addNetwork(n, "rip network of " + m.name);
		for (let n of m.routing.ospf.network || []) addNetwork(n, "ospf network of " + m.name);
	}
	addNetwork("0.0.0.0/0", "default route");

	let peers = [], gateways = [];
	netkit.forEach(function (m, idx) {
		let list = [], ips = {};
		let add = function (ip, label) {
			if (parseIp(ip) !== null && !ips[ip]) {
				ips[ip] = true;
				list.push({ value: ip, label: label });
			}
		};
		for (let own of ifaces(m)) {
			if (!own.eth.domain) continue;
			netkit.forEach(function (o, j) {
				if (j == idx) return;
				for (let i of ifaces(o)) {
					if (i.eth.domain == own.eth.domain && i.ip) add(i.ip.split("/")[0], o.name + " eth" + i.eth.number + asLabel(o));
				}
			});
		}
		gateways.push(list.slice());
		let bgp = m.type == "router" && m.routing && m.routing.bgp;
		if (bgp && bgp.en && bgp.as) {
			netkit.forEach(function (o, j) {
				if (j == idx || o.type != "router" || !o.routing || !o.routing.bgp.en || o.routing.bgp.as != bgp.as) return;
				for (let i of ifaces(o)) {
					if (i.ip) add(i.ip.split("/")[0], o.name + " eth" + i.eth.number + " (iBGP)");
				}
			});
		}
		peers.push(list);
	});

	return { networks: networks, peers: peers, gateways: gateways };
}
