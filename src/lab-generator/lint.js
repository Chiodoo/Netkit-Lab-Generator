/* ---------------------------------------------------------------- */
/* --------------------------- LAB CHECK -------------------------- */
/* typos, values the generator skips silently and configurations    */
/* that cannot work. Uses bgp-policy.js and bgp-as.js              */
/* ---------------------------------------------------------------- */

function maskOf(len) {
	return len == 0 ? 0 : (0xFFFFFFFF << (32 - len)) >>> 0;
}

function inSubnet(ip, c) {
	return ((ip & maskOf(c.len)) >>> 0) == c.net;
}

// "" if s is a network like 10.0.0.0/24
function networkError(s) {
	let c = parseCidr(s);
	if (!c) return "'" + s + "' is not a network like 10.0.0.0/24";
	if (c.addr != c.net) return s + " has host bits set, did you mean " + ipToString(c.net) + "/" + c.len + "?";
	return "";
}

// "" if s is an interface address like 10.0.0.1/24
function hostError(s) {
	let c = parseCidr(s);
	if (!c) return "'" + s + "' is not an address like 10.0.0.1/24";
	if (c.len < 31 && c.addr == c.net)
		return s + " is the network address, use a host address like " + ipToString(c.net + 1) + "/" + c.len;
	if (c.len < 31 && c.addr == (c.net | ~maskOf(c.len)) >>> 0)
		return s + " is the broadcast address of " + ipToString(c.net) + "/" + c.len;
	return "";
}

// addresses added in the free startup text: ip address add 1.1.1.1/32 dev lo
function startupAddresses(m) {
	let list = [], re = /ip\s+(?:address|addr|a)\s+add\s+(\S+)\s+dev\s+(\S+)/g, r;
	while ((r = re.exec(m.interfaces.free || ""))) {
		let c = parseCidr(r[1].indexOf("/") < 0 ? r[1] + "/32" : r[1]);
		let eth = /^eth(\d+)$/.exec(r[2]);
		let i = eth && m.interfaces.if.find(x => x.eth.number == eth[1]);
		if (c) list.push({ c: c, eth: eth ? eth[1] : r[2], domain: i ? i.eth.domain : "" });
	}
	return list;
}

// [{ level: "error" | "warning", machine: index in netkit or -1, text }], errors first
// bgpAs (labInfo.bgpAs, optional): AS relationships and policy models, checked by bgp-as.js
function lintLab(netkit, bgpAs) {
	let issues = [];
	let add = (level, idx, text) => issues.push({ level: level, machine: idx, text: text });
	let name = m => m.name || "machine " + m.row;
	let hasIps = m => m.type != "switch" && m.type != "controller";
	// what the user configures: controllers have no interfaces, eth0 of a switch is reserved for SDN
	let ifaces = m => m.type == "controller" ? [] : m.interfaces.if.filter(i => !(m.type == "switch" && i.eth.number == 0));
	let ifName = a => /^\d+$/.test(a.eth) ? "eth" + a.eth : a.eth;
	let isBgp = m => m.type == "router" && m.routing.bgp.en;

	/* -------- who owns each address -------- */
	let owners = {};	// "10.0.0.1" -> [{ idx, eth, domain, c }]
	netkit.forEach(function (m, idx) {
		if (!hasIps(m)) return;
		let list = ifaces(m).map(i => ({ c: parseCidr(i.ip || ""), eth: i.eth.number, domain: i.eth.domain })).concat(startupAddresses(m));
		for (let a of list) {
			if (!a.c) continue;
			let ip = ipToString(a.c.addr);
			(owners[ip] = owners[ip] || []).push(Object.assign({ idx: idx }, a));
		}
	});
	let ownerOf = ip => (owners[ip] || [])[0];
	let addressesOf = idx => Object.keys(owners).map(ip => Object.assign({ ip: ip }, owners[ip].find(o => o.idx == idx))).filter(o => o.idx !== undefined);
	let where = o => name(netkit[o.idx]) + " " + ifName(o);
	for (let ip in owners) {
		if (owners[ip].length > 1)
			add("error", owners[ip][1].idx, "address " + ip + " is used more than once: " + owners[ip].map(where).join(", "));
	}

	/* -------- collision domains -------- */
	let domains = {};	// "A" -> [{ idx, eth, c }]
	netkit.forEach(function (m, idx) {
		for (let i of ifaces(m)) {
			if (i.eth.domain) (domains[i.eth.domain] = domains[i.eth.domain] || []).push({ idx: idx, eth: i.eth.number, c: hasIps(m) && parseCidr(i.ip || "") });
		}
	});
	let subnetDomain = {};
	for (let d in domains) {
		let members = domains[d], subnets = {};
		for (let o of members) {
			if (o.c) (subnets[ipToString(o.c.net) + "/" + o.c.len] = subnets[ipToString(o.c.net) + "/" + o.c.len] || []).push(o);
		}
		let keys = Object.keys(subnets);
		if (keys.length > 1)
			add("error", subnets[keys[1]][0].idx, "collision domain " + d + " mixes different subnets: "
				+ keys.map(k => k + " (" + subnets[k].map(where).join(", ") + ")").join(", "));
		// switches bridge their collision domains: one subnet across them is normal
		let bridged = members.some(o => netkit[o.idx].type == "switch");
		for (let k of bridged ? [] : keys) {
			if (subnetDomain[k] && subnetDomain[k] != d)
				add("warning", subnets[k][0].idx, "subnet " + k + " is used in collision domains " + subnetDomain[k] + " and " + d + ": is one of them misspelled?");
			subnetDomain[k] = d;
		}
		let twin = Object.keys(domains).find(x => x < d && x.toLowerCase() == d.toLowerCase());
		if (twin) add("warning", members[0].idx, "collision domains " + twin + " and " + d + " differ only in case: is one of them misspelled?");
		let machines = members.map(o => o.idx).filter((x, i, a) => a.indexOf(x) == i);
		for (let idx of machines) {
			let own = members.filter(o => o.idx == idx);
			if (own.length > 1) add("warning", idx, name(netkit[idx]) + " has " + own.map(ifName).join(" and ") + " in the same collision domain " + d);
		}
	}
	let hasRouters = netkit.some(m => m.type == "router");

	/* -------- machines -------- */
	let names = {};
	netkit.forEach(function (m, idx) {
		let n = name(m);
		if (!m.name || !/^[A-Za-z0-9_-]+$/.test(m.name))
			add("error", idx, n + ": " + (m.name ? "invalid name" : "no name") + ", nothing is generated until every machine has a valid name (letters, digits, _)");
		else if (!/^[a-z0-9_]{1,30}$/.test(m.name))
			add("warning", idx, n + ": use only lowercase letters, digits and _ (at most 30) in machine names");
		if (m.name && names[m.name] !== undefined) add("error", idx, n + ": two machines have the same name");
		names[m.name] = idx;

		for (let i of ifaces(m)) {
			let eth = n + " eth" + i.eth.number;
			if (!i.eth.domain) add("error", idx, eth + ": no collision domain, the interface is not declared in lab.conf");
			else if (!/^[A-Za-z0-9_.-]+$/.test(i.eth.domain)) add("error", idx, eth + ": invalid collision domain '" + i.eth.domain + "'");
			if (!hasIps(m)) continue;
			if (i.ip) {
				let err = hostError(i.ip);
				if (err) add("error", idx, eth + ": " + err);
			} else if (i.eth.domain) {
				add("warning", idx, eth + ": no IP address");
			}
			if (i.name && !/\.$/.test(i.name)) add("error", idx, eth + ": the DNS name " + i.name + " must end with '.'");
		}
		if (m.type == "other" && !m.other.image) add("error", idx, n + ": no image name, the machine is not generated");
		if (m.type == "other" && m.other.files.some(f => !f.name)) add("error", idx, n + ": a file has no name");
		if (hasIps(m)) lintGateways(m, idx);
		if (m.type == "terminal" && m.pc.dns && m.pc.dns != "-"
			&& !netkit.some(o => o.type == "ns" && o.ns.recursion && o.interfaces.if.some(i => i.ip && i.ip.split("/")[0] == m.pc.dns)))
			add("warning", idx, n + ": the DNS " + m.pc.dns + " is not a recursive name server of the lab");
		if (m.type == "ns" && m.ns.authority) {
			if (!m.ns.zone || !/(^\..*\.$)|^\.$/.test(m.ns.zone)) add("error", idx, n + ": the zone must be like .com. (or . for the root)");
			if (!m.interfaces.if[0].name) add("error", idx, n + ": an authoritative name server needs the DNS name of eth0");
		}
		if (m.type == "router") lintRouter(m, idx);
	});
	if (netkit.some(m => m.type == "ns") && !netkit.some(m => m.type == "ns" && m.ns.authority && m.ns.zone == "."))
		add("warning", -1, "there is no root name server (authority for zone .): the DNS files are not generated");

	function lintGateways(m, idx) {
		let n = name(m), hasGw = false;
		for (let g of m.gateways.gw) {
			if (!g.gw) {
				if (g.route) add("warning", idx, n + ": route " + g.route + " has no gateway, it is not generated");
				continue;
			}
			hasGw = true;
			let what = n + " route " + (g.route || "default") + " via " + g.gw;
			if (g.route && networkError(g.route)) add("error", idx, what + ": " + networkError(g.route));
			let gw = parseIp(g.gw);
			if (gw === null) {
				add("error", idx, what + ": '" + g.gw + "' is not an address like 10.0.0.1");
				continue;
			}
			let i = m.interfaces.if.find(x => x.eth.number == g.if);
			if (!i) {
				add("error", idx, what + ": eth" + g.if + " is not declared");
				continue;
			}
			let c = parseCidr(i.ip || ""), o = ownerOf(g.gw);
			if (c && !inSubnet(gw, c)) add("error", idx, what + ": " + g.gw + " is not in the subnet of eth" + g.if + " (" + ipToString(c.net) + "/" + c.len + ")");
			else if (!o) add("error", idx, what + ": no machine has the address " + g.gw);
			else if (o.idx == idx) add("error", idx, what + ": " + g.gw + " is an address of " + n + " itself");
			else if (i.eth.domain && o.domain && o.domain != i.eth.domain)
				add("error", idx, what + ": " + g.gw + " is " + where(o) + " in collision domain " + o.domain + ", but eth" + g.if + " is in " + i.eth.domain);
		}
		if (!hasGw && m.type != "router" && hasRouters && !/route/.test(m.interfaces.free || ""))
			add("warning", idx, n + ": no gateway, it can reach only its own collision domain");
	}

	function lintNetworks(m, idx, proto, networks) {
		let mine = addressesOf(idx);
		for (let net of networks || []) {
			if (!net) continue;
			let err = networkError(net);
			if (err) add("error", idx, name(m) + " " + proto + " network: " + err);
			else if (proto != "bgp" && !mine.some(a => inSubnet(a.c.addr, parseCidr(net))))
				add("warning", idx, name(m) + " " + proto + " network " + net + " contains no interface of " + name(m) + ": " + proto + " does not run on any interface for it");
		}
	}

	function lintRouter(m, idx) {
		let n = name(m), r = m.routing;
		let on = { rip: r.rip.en, ospf: r.ospf.en, bgp: r.bgp.en };
		for (let p of ["rip", "ospf"]) {
			if (!on[p]) continue;
			if (!r[p].network.some(x => x)) add("warning", idx, n + ": " + p + " is enabled but has no network");
			lintNetworks(m, idx, p, r[p].network);
			for (let other of ["rip", "ospf", "bgp"]) {
				if (r[p][other] && !on[other]) add("warning", idx, n + ": " + p + " redistributes " + other + ", which is not enabled");
			}
		}
		if (on.rip) {
			for (let route of r.rip.route || []) {
				if (route && networkError(route)) add("error", idx, n + " rip route: " + networkError(route));
			}
		}
		if (on.ospf) {
			r.ospf.network.forEach(function (net, k) {
				let area = r.ospf.area[k];
				if (!net) return;
				if (parseIp(area || "") === null && !isUint(area, MAX_UINT32)) add("error", idx, n + " ospf network " + net + ": the area must be like 0.0.0.0");
				else if (r.ospf.stub[k] && (area == "0" || parseIp(area) === 0)) add("error", idx, n + " ospf network " + net + ": the backbone area 0 cannot be stub");
			});
			let seen = {};
			for (let cost of r.ospf.if || []) {
				if (!cost || !hasValue(cost.cost)) continue;
				let eth = "eth" + cost.interface;
				if (!hasValue(cost.interface)) add("error", idx, n + ": ospf cost " + cost.cost + " has no interface chosen");
				else if (!m.interfaces.if.some(i => i.eth.number == cost.interface)) add("error", idx, n + ": ospf cost on " + eth + ", which is not declared");
				else if (seen[eth]) add("warning", idx, n + ": two ospf costs on " + eth + ", only the last one counts");
				if (!isUint(cost.cost, 65535) || +cost.cost < 1) add("error", idx, n + ": ospf cost '" + cost.cost + "' must be a number between 1 and 65535");
				seen[eth] = true;
			}
		}
		if (on.bgp) lintBgp(m, idx);
	}

	function lintBgp(m, idx) {
		let n = name(m), bgp = m.routing.bgp, frr = m.routingSoftware == "frr", free = bgp.free || "";
		let mine = addressesOf(idx);
		if (!isUint(bgp.as, MAX_UINT32) || +bgp.as < 1) add("error", idx, n + ": the AS number is missing or not a number");
		lintNetworks(m, idx, "bgp", bgp.network);

		let neighbors = {}, eff = effectiveBgp(m, bgpAs);	// with the applied auto-generated route-maps
		for (let remote of bgp.remote) {
			if (!remote || (!remote.neighbor && !remote.as)) continue;
			let ip = remote.neighbor, what = n + " neighbor " + ip;
			if (!ip) {
				add("warning", idx, n + ": a neighbor with remote-as " + remote.as + " has no address, it is not generated");
				continue;
			}
			if (parseIp(ip) === null) {
				add("error", idx, what + ": not an address like 10.0.0.1");
				continue;
			}
			if (neighbors[ip]) add("warning", idx, what + ": declared twice");
			neighbors[ip] = true;
			if (!remote.as) add("error", idx, what + ": no remote-as, the neighbor is not generated");
			else if (!isUint(remote.as, MAX_UINT32)) add("error", idx, what + ": the remote-as must be a number");
			let err = neighborPolicyError(remote);
			if (err) add("error", idx, what + ": " + err);

			let o = ownerOf(ip), peer = o && netkit[o.idx];
			if (!o) {
				add("error", idx, what + ": no machine has this address");
				continue;
			}
			if (o.idx == idx) {
				add("error", idx, what + ": this is an address of " + n + " itself");
				continue;
			}
			if (!isBgp(peer)) {
				add("error", idx, what + " is " + where(o) + ", which does not run BGP");
				continue;
			}
			if (remote.as && peer.routing.bgp.as && remote.as != peer.routing.bgp.as)
				add("error", idx, what + " is " + where(o) + " in AS " + peer.routing.bgp.as + ", not AS " + remote.as);

			// the peer must declare the address this router uses towards it
			let back = peer.routing.bgp.remote.find(x => x && mine.some(a => a.ip == x.neighbor));
			let towards = mine.filter(a => a.domain && a.domain == o.domain);
			if (!back && !mine.some(a => (peer.routing.bgp.free || "").indexOf("neighbor " + a.ip + " ") >= 0))
				add("error", idx, what + ": " + name(peer) + " has no neighbor statement for " + n
					+ (towards.length ? " (" + towards[0].ip + ")" : "") + ", the session does not come up");
			else if (back && towards.length && !towards.some(a => a.ip == back.neighbor))
				add("warning", idx, what + ": " + name(peer) + " peers with " + back.neighbor + ", but " + n + " reaches it from " + towards[0].ip);

			let ebgp = remote.as != bgp.as;
			if (ebgp && !towards.length && free.indexOf("ebgp-multihop") < 0)
				add("warning", idx, what + " (" + where(o) + ") does not share a collision domain with " + n + ": an eBGP session needs ebgp-multihop");
			if (ebgp && frr && !bgp.noEbgpRequiresPolicy && free.indexOf("no bgp ebgp-requires-policy") < 0) {
				let applied = eff.remote[bgp.remote.indexOf(remote)].apply;
				let missing = ["in", "out"].filter(dir => !NEIGHBOR_POLICY_CMDS.some(c => applied && findPolicy(eff.policies, applied[c.cmd] && applied[c.cmd][dir], c.type))
					&& !new RegExp("neighbor " + ip.replace(/\./g, "\\.") + " (route-map|prefix-list|distribute-list|filter-list) \\S+ " + dir).test(free));
				if (missing.length)
					add("warning", idx, what + ": eBGP without " + missing.join("/") + " policy, FRR (ebgp-requires-policy) "
						+ (missing.length == 2 ? "exchanges no routes" : missing[0] == "in" ? "accepts no routes from it" : "announces nothing to it")
						+ ", tick 'no bgp ebgp-requires-policy' or apply a policy");
			}
		}

		for (let policy of bgp.policies || []) {
			let what = n + " " + policy.type + " " + (policy.name || "(no name)");
			let err = policyError(bgp.policies, policy);
			if (err) add("error", idx, what + ": " + err);
			else if (policyWarning(policy)) add("warning", idx, what + ": " + policyWarning(policy));
			for (let rule of policy.rules) {
				err = policyRuleError(bgp.policies, policy, rule);
				if (err) add("error", idx, what + " seq " + rule.seq + ": " + err);
				else if (policyRuleWarning(policy, rule)) add("warning", idx, what + " seq " + rule.seq + ": " + policyRuleWarning(policy, rule));
			}
		}
	}

	issues = issues.concat(bgpAsIssues(netkit, bgpAs).filter(i => !i.quiet));
	return issues.filter(i => i.level == "error").concat(issues.filter(i => i.level == "warning"));
}
