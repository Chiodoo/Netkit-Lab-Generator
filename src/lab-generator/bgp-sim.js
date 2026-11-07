/* ---------------------------------------------------------------- */
/* ------------------------ BGP SIMULATION ------------------------ */
/* Approximates what FRR does with the configuration the generator  */
/* writes (effectiveBgp): sessions, import/export policies, decision */
/* process, an approximate RIP/OSPF and the forwarding of packets.   */
/* Pure functions, no DOM. Uses bgp-policy.js, bgp-as.js, lint.js.   */
/* ---------------------------------------------------------------- */

var SIM_NOTE = "This is an approximation of FRR computed from the lab configuration: the real check is show ip bgp (and show ip route) on the running lab.";
var SIM_MAX_PASSES = 100;
var SIM_AD = { connected: 0, static: 1, ebgp: 20, ospf: 110, rip: 120, ibgp: 200 };
var SIM_ORIGINS = ["i", "e", "?"];

function simKey(c) {
	return ipToString(c.net) + "/" + c.len;
}

function simContains(c, ip) {
	return ((ip & maskOf(c.len)) >>> 0) == c.net;
}

function simNet(c) {
	return { net: c.net, len: c.len, addr: c.net };
}

/* -------------------- lab model -------------------- */

// routers and hosts with addresses, static routes, BGP configuration (with the applied auto route-maps) and free text
function simMachines(netkit, bgpAs, down, warnings) {
	let machines = [], byName = {};
	let warn = (m, text) => warnings.push({ machine: m ? m.name : "", text: text });
	if (netkit.some(m => m.type == "switch")) warn(null, "SDN switches are not simulated: their collision domains are treated as separate links");

	netkit.forEach(function (m, idx) {
		if (!m.name || m.type == "switch" || m.type == "controller") return;
		if (byName[m.name]) return warn(m, m.name + " is defined twice: only the first one is simulated");
		let M = { name: m.name, idx: idx, m: m, router: m.type == "router", addrs: [], statics: [], warn: t => warn(M, M.name + ": " + t) };
		byName[m.name] = M;
		machines.push(M);

		for (let i of m.interfaces.if) {
			let c = parseCidr(i.ip || "");
			if (c && i.eth.domain) M.addrs.push({ ip: c.addr, c: simNet(c), dev: "eth" + i.eth.number, domain: i.eth.domain });
		}
		for (let a of startupAddresses(m))
			M.addrs.push({ ip: a.c.addr, c: simNet(a.c), dev: /^\d+$/.test(a.eth) ? "eth" + a.eth : a.eth, domain: a.domain });
		for (let a of M.addrs) a.up = !a.domain || !down.domains[a.domain];

		let addStatic = function (route, gw, where) {
			let c = route == "default" || route == "" ? parseCidr("0.0.0.0/0") : parseCidr(route.indexOf("/") < 0 ? route + "/32" : route);
			let nh = parseIp(gw);
			if (c && nh !== null) M.statics.push({ c: simNet(c), nh: nh });
			else M.warn("static route '" + route + " via " + gw + "' in " + where + " not understood, ignored");
		};
		for (let g of m.gateways.gw) if (g.gw) addStatic(g.route || "", g.gw, "the gateways");
		for (let line of (m.interfaces.free || "").split("\n")) {
			let r = /^\s*ip\s+route\s+add\s+(\S+)\s+via\s+(\S+)/.exec(line);
			if (r) addStatic(r[1], r[2], "the startup free text");
			else if (/\b(ip\s+route|route\s+add)\b/.test(line)) M.warn("'" + line.trim() + "' in the startup free text is not simulated");
		}
		if (M.router) simRouterConfig(M, bgpAs);
	});
	return { list: machines, byName: byName };
}

function simFreeLines(text) {
	return (text || "").split("\n").map(l => l.trim()).filter(l => l && l[0] != "!");
}

function simRouterConfig(M, bgpAs) {
	let r = M.m.routing;
	M.frr = M.m.routingSoftware != "quagga";
	for (let line of simFreeLines(r.frr.free)) {
		let s = /^ip route (\S+) (\S+)$/.exec(line);
		if (s && parseCidr(s[1]) && parseIp(s[2]) !== null) M.statics.push({ c: simNet(parseCidr(s[1])), nh: parseIp(s[2]) });
		else if (!/^(log|debug|hostname|password|enable password|service|line|exit|end)\b/.test(line))
			M.warn("'" + line + "' in the FRR free text is not simulated");
	}
	for (let p of ["rip", "ospf"]) {
		if (!r[p].en) continue;
		for (let line of simFreeLines(r[p].free)) M.warn("'" + line + "' in the " + p.toUpperCase() + " free text is not simulated");
	}
	if (r.ospf.en && r.ospf.stub.some(s => s)) M.warn("OSPF stub areas are simulated as normal areas");

	let bgp = r.bgp;
	if (!bgp.en || !validAsn(bgp.as)) return;
	let eff = effectiveBgp(M.m, bgpAs);
	M.asn = +asn(bgp.as);
	M.eff = eff;
	M.requiresPolicy = M.frr && !bgp.noEbgpRequiresPolicy;
	M.importCheck = M.frr && !bgp.noNetworkImportCheck;
	M.networks = (bgp.network || []).filter(n => n);
	M.redistribute = [];
	M.nbr = {};	// free text per neighbor address: shutdown, nextHopSelf, multihop, updateSource, defaultOriginate
	let nbr = ip => M.nbr[ip] = M.nbr[ip] || {};
	for (let line of simFreeLines(bgp.free)) {
		let n, x;
		if (/^(log|debug)\b/.test(line)) continue;
		else if (line == "no bgp ebgp-requires-policy") M.requiresPolicy = false;
		else if (line == "no bgp network import-check") M.importCheck = false;
		else if (line == "bgp network import-check") M.importCheck = true;
		else if ((x = /^bgp router-id (\S+)$/.exec(line)) && parseIp(x[1]) !== null) M.rid = parseIp(x[1]);
		else if ((x = /^network (\S+)$/.exec(line))) M.networks.push(x[1]);
		else if ((x = /^redistribute (connected|static|rip|ospf)$/.exec(line))) M.redistribute.push(x[1]);
		else if ((n = /^neighbor (\S+) (.*)$/.exec(line)) && parseIp(n[1]) !== null) {
			let o = nbr(n[1]), what = n[2];
			if (what == "shutdown") o.shutdown = true;
			else if (/^next-hop-self( force)?$/.test(what)) o.nextHopSelf = true;
			else if (/^ebgp-multihop( \d+)?$/.test(what)) o.multihop = true;
			else if ((x = /^update-source (\S+)$/.exec(what))) o.updateSource = x[1];
			else if (what == "default-originate") o.defaultOriginate = true;
			else if (/^description /.test(what)) continue;
			else M.warn("'" + line + "' in the BGP free text is not simulated");
		}
		else M.warn("'" + line + "' in the BGP free text is not simulated");
	}
	for (let p of eff.policies) {
		if (p.type != "route-map") continue;
		for (let rule of p.rules) {
			let kinds = rule.matches.map(m => m.match);
			if (kinds.some((k, i) => kinds.indexOf(k) != i))
				M.warn("route-map " + p.name + " seq " + rule.seq + " has two 'match' of the same kind: FRR keeps only the last one, the simulation does the same");
		}
	}
}

function simRouterId(M) {
	if (M.rid !== undefined) return M.rid;
	let real = M.addrs.filter(a => (a.ip >>> 24) != 127);
	let lo = real.filter(a => a.dev == "lo");
	return Math.max(0, ...(lo.length ? lo : real).map(a => a.ip));
}

/* -------------------- policies -------------------- */

// the rules FRR ends up with for a list name: the generator skips invalid rules, a later rule with the same seq replaces the earlier one
function simDefinition(M, type, name) {
	let cache = M.defs = M.defs || {}, k = type + " " + name;
	if (cache[k]) return cache[k];
	let policies = M.eff.policies, bySeq = {};
	for (let p of policies) {
		if (p.type != type || p.name != name || policyNameError(p)) continue;
		for (let rule of p.rules) if (!policyRuleError(policies, p, rule)) bySeq[+rule.seq] = rule;
	}
	return cache[k] = Object.keys(bySeq).map(s => bySeq[s]).sort((a, b) => a.seq - b.seq);
}

function simAsPathString(path) {
	return path.join(" ");
}

function simListMatch(type, rule, route) {
	let p = route.prefix;
	switch (type) {
		case "prefix-list": {
			if (rule.prefix == "any") return true;
			let c = parseCidr(rule.prefix);
			if (p.len < c.len || !simContains(c, p.net)) return false;
			if (!hasValue(rule.ge) && !hasValue(rule.le)) return p.len == c.len;
			return p.len >= (hasValue(rule.ge) ? +rule.ge : c.len) && p.len <= (hasValue(rule.le) ? +rule.le : 32);
		}
		case "access-list": {
			if (rule.prefix == "any") return true;
			let c = parseCidr(rule.prefix);
			return rule.exactMatch ? p.len == c.len && p.net == c.net : p.len >= c.len && simContains(c, p.net);
		}
		case "as-path": {
			let re;
			try { re = new RegExp(String(rule.regex).replace(/_/g, "(?:^|$|[ ,{}()])")); } catch (e) { return false; }
			return re.test(simAsPathString(route.path));
		}
	}
	return false;
}

// { permit, seq } of the first matching rule, null if no rule matches (implicit deny)
function simListApply(M, type, name, route) {
	for (let rule of simDefinition(M, type, name)) {
		if (simListMatch(type, rule, route)) return { permit: rule.action == "permit", seq: rule.seq };
	}
	return null;
}

function simSet(route, set, ebgpOut) {
	let v = String(set.value).trim();
	switch (set.set) {
		case "local-preference": if (!ebgpOut) route.lp = +v; break;
		case "metric": route.med = +v; break;
		case "as-path prepend": route.path = v.split(/\s+/).map(Number).concat(route.path); break;
		case "community": {
			let tokens = v.split(/\s+/), add = tokens.indexOf("additive") >= 0;
			tokens = tokens.filter(t => t != "additive");
			route.communities = tokens.indexOf("none") >= 0 ? [] : (add ? route.communities : []).concat(tokens);
		}
	}
}

// { route } (a modified copy) or { reason } why it is filtered
function simRouteMap(M, name, route, ebgpOut, at) {
	let rules = simDefinition(M, "route-map", name);
	if (!rules.length) return { reason: "route-map " + name + at + " is not defined (no valid rules): FRR denies everything" };
	for (let rule of rules) {
		let last = {};
		for (let m of rule.matches) last[m.match] = m;	// FRR keeps the last match of each kind
		let ok = Object.keys(last).every(function (kind) {
			let type = ROUTE_MAP_MATCHES.find(d => d.match == kind).type;
			let list = findPolicy(M.eff.policies, last[kind].value, type);
			let res = list && simListApply(M, type, list.name, route);
			return res && res.permit;
		});
		if (!ok) continue;
		if (rule.action == "deny") return { reason: "denied by route-map " + name + " seq " + rule.seq + at };
		let out = simCopy(route);
		for (let s of rule.sets) simSet(out, s, ebgpOut);
		return { route: out, by: "route-map " + name + " seq " + rule.seq };
	}
	return { reason: "route-map " + name + at + ": no entry matches (implicit deny)" };
}

function simApplied(M, remote, cmd, dir) {
	let def = NEIGHBOR_POLICY_CMDS.find(c => c.cmd == cmd);
	let p = remote.apply && remote.apply[cmd] && findPolicy(M.eff.policies, remote.apply[cmd][dir], def.type);
	return p && !policyNameError(p) ? p : null;
}

function simHasPolicy(M, remote, dir) {
	return NEIGHBOR_POLICY_CMDS.some(c => simApplied(M, remote, c.cmd, dir));
}

// neighbor filters, in the order of FRR: distribute-list, prefix-list, filter-list, then route-map
function simPolicies(M, remote, dir, route, ebgp) {
	let at = " (" + dir + " on " + M.name + ", neighbor " + remote.neighbor + ")";
	for (let cmd of ["distribute-list", "prefix-list", "filter-list"]) {
		let p = simApplied(M, remote, cmd, dir);
		if (!p) continue;
		let type = NEIGHBOR_POLICY_CMDS.find(c => c.cmd == cmd).type;
		if (!simDefinition(M, type, p.name).length) return { reason: cmd + " " + p.name + at + " is not defined (no valid rules): FRR denies everything" };
		let res = simListApply(M, type, p.name, route);
		if (!res) return { reason: "filtered by " + cmd + " " + p.name + at + ": no rule matches (implicit deny)" };
		if (!res.permit) return { reason: "filtered by " + cmd + " " + p.name + at + " (deny, seq " + res.seq + ")" };
	}
	let rm = simApplied(M, remote, "route-map", dir);
	if (!rm) return { route: route };
	return simRouteMap(M, rm.name, route, ebgp && dir == "out", at);
}

/* -------------------- routes -------------------- */

// BGP path: { prefix, key, path, origin, med, lp, nh, communities, local, ebgp, end (receiving session end), rid, peerIp, igp, status, reason }
function simCopy(r) {
	return Object.assign({}, r, { path: r.path.slice(), communities: r.communities.slice() });
}

function simCompare(a, b) {
	let lp = x => x.lp === undefined ? 100 : x.lp, med = x => x.med || 0;
	let first = x => x.path.length ? x.path[0] : null, sameAs = first(a) === first(b);
	let steps = [
		[x => x.local ? 0 : 1, () => "locally originated"],
		[x => -lp(x), () => "higher local-pref (" + lp(a) + " vs " + lp(b) + ")"],
		[x => x.path.length, () => "shorter AS-path (" + a.path.length + " vs " + b.path.length + ")"],
		[x => x.origin, () => "lower origin (" + SIM_ORIGINS[a.origin] + " vs " + SIM_ORIGINS[b.origin] + ")"],
		[x => sameAs ? med(x) : 0, () => "lower MED (" + med(a) + " vs " + med(b) + ", both from AS " + first(a) + ")"],
		[x => x.ebgp ? 0 : 1, () => "eBGP over iBGP"],
		[x => x.igp, () => "lower IGP cost to the next hop (" + a.igp + " vs " + b.igp + ")"],
		[x => x.rid, () => "lower router-id (" + ipToString(a.rid) + " vs " + ipToString(b.rid) + ")"
			+ (a.ebgp && b.ebgp ? "; on a full tie FRR may keep the older route instead" : "")],
		[x => x.peerIp, () => "lower neighbor address (" + ipToString(a.peerIp) + " vs " + ipToString(b.peerIp) + ")"]
	];
	for (let s of steps) {
		let d = s[0](a) - s[0](b);
		if (d) return { d: d, label: s[1]() };
	}
	return { d: 0, label: "identical" };
}

/* -------------------- forwarding table -------------------- */

function simBuildFib(M) {
	let fib = {};
	let add = function (e) {
		let k = simKey(e.c), old = fib[k];
		if (!old || e.ad < old.ad) fib[k] = e;
	};
	for (let a of M.addrs) if (a.up) add({ c: a.c, type: "connected", ad: 0, dev: a.dev, domain: a.domain, src: a.ip });
	for (let s of M.statics) add({ c: s.c, type: "static", ad: SIM_AD.static, nh: s.nh });
	for (let p of ["rip", "ospf"]) {
		for (let k in (M.igp && M.igp[p]) || {}) {
			let e = M.igp[p][k];
			add({ c: e.c, type: p, ad: SIM_AD[p], nh: e.nh, metric: e.metric, hops: e.hops, from: e.origin });
		}
	}
	for (let k in M.best || {}) {
		let b = M.best[k];
		if (!b.local) add({ c: b.prefix, type: b.ebgp ? "ebgp" : "ibgp", ad: b.ebgp ? SIM_AD.ebgp : SIM_AD.ibgp, nh: b.nh, route: b });
	}
	M.fib = fib;
	M.fibList = Object.keys(fib).map(k => fib[k]).sort((a, b) => b.c.len - a.c.len);
}

// longest prefix match; FRR resolves next hops without the default route (no ip nht resolve-via-default)
// and a BGP route cannot resolve its next hop through itself (exclude: its prefix)
function simLookup(M, ip, noDefault, exclude) {
	return (M.fibList || []).find(e => simContains(e.c, ip) && !(noDefault && e.c.len == 0) && !(e.route && simKey(e.c) == exclude)) || null;
}

// { ip of the directly connected next hop, cost (hops), domain } or null
function simResolve(M, ip, exclude, depth) {
	let e = simLookup(M, ip, true, exclude);
	if (!e) return null;
	if (e.type == "connected") return { ip: ip, cost: 0, domain: e.domain, src: e.src };
	if ((depth || 0) > 8) return null;
	let r = simResolve(M, e.nh, exclude, (depth || 0) + 1);
	if (!r) return null;
	return Object.assign({}, r, { cost: r.cost + (e.hops || 1) });
}

/* -------------------- IGP (approximation) -------------------- */

// RIP and OSPF run on the interfaces inside their network statements; every router learns the subnets of the
// others along the shortest path (RIP: hops, at most 15; OSPF: sum of the interface costs, 10 by default)
function simIgp(machines, proto) {
	let rs = machines.filter(M => M.router && M.m.routing[proto].en);
	let other = proto == "rip" ? "ospf" : "rip";
	for (let R of rs) {
		let cfg = R.m.routing[proto];
		let nets = cfg.network.map(n => parseCidr(n || "")).filter(c => c);
		R.igpIf = R.igpIf || {};
		R.igpIf[proto] = R.addrs.filter(a => a.up && nets.some(c => simContains(simNet(c), a.ip)));
		let own = {}, put = c => own[simKey(c)] = c;
		R.igpIf[proto].forEach(a => put(a.c));
		if (cfg.connected) R.addrs.filter(a => a.up).forEach(a => put(a.c));
		if (cfg.bgp) for (let k in R.best || {}) if (!R.best[k].local) put(R.best[k].prefix);
		if (cfg[other]) for (let k in (R.igp && R.igp[other]) || {}) put(R.igp[other][k].c);
		if (proto == "rip") for (let x of cfg.route || []) { let c = parseCidr(x || ""); if (c) put(simNet(c)); }
		R.igpOwn = R.igpOwn || {};
		R.igpOwn[proto] = own;
	}
	let cost = function (R, a) {
		if (proto == "rip") return 1;
		let c = (R.m.routing.ospf.if || []).filter(x => x && "eth" + x.interface == a.dev && isUint(x.cost, 65535)).pop();
		return c ? +c.cost : 10;
	};
	let result = {};
	for (let R of rs) {
		// Dijkstra over the routers of the protocol, neighbors in the same collision domain
		let dist = {}, hops = {}, first = {}, done = {};
		dist[R.name] = 0; hops[R.name] = 0;
		for (;;) {
			let u = rs.filter(X => dist[X.name] !== undefined && !done[X.name]).sort((p, q) => dist[p.name] - dist[q.name])[0];
			if (!u) break;
			done[u.name] = true;
			for (let a of u.igpIf[proto]) {
				for (let O of rs) {
					if (O === u || !a.domain) continue;
					let b = O.igpIf[proto].find(x => x.domain == a.domain);
					if (!b) continue;
					let d = dist[u.name] + cost(u, a);
					if (dist[O.name] === undefined || d < dist[O.name]) {
						dist[O.name] = d;
						hops[O.name] = hops[u.name] + 1;
						first[O.name] = u === R ? b.ip : first[u.name];
					}
				}
			}
		}
		let table = {};
		for (let O of rs) {
			if (O === R || dist[O.name] === undefined) continue;
			for (let k in O.igpOwn[proto]) {
				let metric = dist[O.name] + (proto == "rip" ? 1 : 0);
				if (proto == "rip" && metric > 15) continue;
				if (!table[k] || metric < table[k].metric)
					table[k] = { c: O.igpOwn[proto][k], nh: first[O.name], metric: metric, hops: hops[O.name], origin: O.name };
			}
		}
		result[R.name] = table;
	}
	return result;
}

/* -------------------- sessions -------------------- */

function simSessions(ms, down) {
	let owner = {};
	for (let M of ms.list) for (let a of M.addrs) if (owner[a.ip] === undefined) owner[a.ip] = M;
	let sessions = [], byKey = {};
	for (let R of ms.list) {
		if (!R.eff) continue;
		R.ends = [];
		for (let remote of R.eff.remote) {
			if (!remote || !remote.neighbor || !validAsn(remote.as) || parseIp(remote.neighbor) === null) continue;
			let ip = parseIp(remote.neighbor), O = owner[ip];
			let back = O && O.eff && O !== R ? O.eff.remote.find(x => x && x.neighbor && validAsn(x.as) && R.addrs.some(a => a.ip == parseIp(x.neighbor))) : null;
			let key = back ? [R.name + " " + remote.neighbor, O.name + " " + back.neighbor].sort().join(" | ") : R.name + " " + remote.neighbor;
			let s = byKey[key];
			if (!s) {
				s = byKey[key] = { key: key, ebgp: +asn(remote.as) != R.asn, ends: [] };
				sessions.push(s);
				let why = "";
				if (!O) why = "no machine has the address " + remote.neighbor;
				else if (O === R) why = remote.neighbor + " is an address of " + R.name + " itself";
				else if (!O.eff) why = remote.neighbor + " is " + O.name + ", which does not run BGP";
				else if (+asn(remote.as) != O.asn) why = R.name + " says remote-as " + asn(remote.as) + " but " + O.name + " is in AS " + O.asn;
				else if (!back) why = O.name + " has no neighbor statement for " + R.name;
				else if (+asn(back.as) != R.asn) why = O.name + " says remote-as " + asn(back.as) + " but " + R.name + " is in AS " + R.asn;
				s.staticWhy = why;
			}
			let end = { s: s, r: R, remote: remote, peerIp: ip, free: R.nbr[remote.neighbor] || {} };
			s.ends.push(end);
			R.ends.push(end);
		}
	}
	for (let s of sessions) {
		if (s.ends.length == 2) [s.ends[0].other, s.ends[1].other] = [s.ends[1], s.ends[0]];
		let shut = s.ends.find(e => e.free.shutdown);
		if (!s.staticWhy && shut) s.staticWhy = "neighbor " + shut.remote.neighbor + " shutdown on " + shut.r.name;
		if (!s.staticWhy && down.sessions[s.key]) s.staticWhy = "marked down in the simulation";
		s.label = s.ends.map(e => e.r.name + " (" + (e.other ? e.other.remote.neighbor : "?") + ")").join(" - ")
			+ (s.ends.length == 1 ? " -> " + s.ends[0].remote.neighbor : "") + (s.ebgp ? " eBGP" : " iBGP");
	}
	return sessions;
}

// the address a router uses towards a neighbor: the interface on the neighbor's subnet or towards its route
function simSource(R, ip, updateSource) {
	if (updateSource) {
		let a = parseIp(updateSource) !== null ? R.addrs.find(x => x.ip == parseIp(updateSource)) : R.addrs.find(x => x.dev == updateSource);
		return a && a.up ? a.ip : null;
	}
	let direct = R.addrs.find(a => a.up && a.domain && simContains(a.c, ip));
	if (direct) return direct.ip;
	let r = simResolve(R, ip);
	return r ? r.src : null;
}

function simSessionState(s) {
	s.up = false;
	s.why = s.staticWhy;
	if (s.why) return;
	let [a, b] = s.ends;
	for (let e of s.ends) {
		e.src = simSource(e.r, e.peerIp, e.free.updateSource);
		e.direct = e.r.addrs.some(x => x.up && x.domain && simContains(x.c, e.peerIp));
	}
	for (let e of s.ends) {
		let gone = e.r.addrs.find(x => !x.up && x.domain && simContains(x.c, e.peerIp));
		if (s.ebgp && !e.direct && !e.free.multihop) {
			s.why = gone ? "collision domain " + gone.domain + " is down" : e.r.name + " is not on a collision domain with " + e.remote.neighbor + " (eBGP needs ebgp-multihop)";
			return;
		}
		if (e.src === null) {
			s.why = e.r.name + " has no route to " + e.remote.neighbor;
			return;
		}
	}
	if (a.src != b.peerIp && b.src != a.peerIp) {
		s.why = a.r.name + " connects from " + ipToString(a.src) + " but " + b.r.name + " expects " + b.remote.neighbor + " (update-source?)";
		return;
	}
	s.up = true;
}

/* -------------------- exchange of routes -------------------- */

// the route the sender (end.r) announces on the session: { route } or { reason }
function simExport(end, b) {
	let P = end.r, s = end.s, recv = end.other;
	if (b.end && b.end.s === s) return { reason: "learned from this neighbor" };
	if (!s.ebgp && !b.local && !b.ebgp) return { reason: "learned via iBGP: not announced to iBGP peers" };
	if (b.communities.indexOf("no-advertise") >= 0) return { reason: "community no-advertise" };
	if (s.ebgp && b.communities.indexOf("no-export") >= 0) return { reason: "community no-export: not announced to other ASes" };
	if (b.key == "0.0.0.0/0" && simDefaultOriginate(end)) return { reason: "replaced by default-originate" };
	if (s.ebgp && P.requiresPolicy && !simHasPolicy(P, end.remote, "out"))
		return { reason: P.name + " has no outbound policy for " + end.remote.neighbor + ": FRR (ebgp-requires-policy) announces nothing" };
	let r = simCopy(b);
	if (s.ebgp) {
		delete r.lp;
		if (!b.local) delete r.med;	// MED does not leave the neighboring AS
		r.nh = end.src;
	} else {
		r.lp = b.lp === undefined ? 100 : b.lp;
		if (b.local || end.free.nextHopSelf) r.nh = end.src;
	}
	let res = simPolicies(P, end.remote, "out", r, s.ebgp);
	if (!res.route) return res;
	r = res.route;
	if (s.ebgp) r.path = [P.asn].concat(r.path);
	return { route: simReceived(r, recv) };
}

function simDefaultOriginate(end) {
	return end.remote.defaultOriginate || end.free.defaultOriginate;
}

// default-originate: announced even without a default route, not filtered by the outbound policies
function simDefaultRoute(end) {
	let P = end.r, c = simNet(parseCidr("0.0.0.0/0"));
	let r = { prefix: c, key: "0.0.0.0/0", path: end.s.ebgp ? [P.asn] : [], origin: 0, nh: end.src, communities: [], defaultOriginate: true };
	if (!end.s.ebgp) r.lp = 100;
	return simReceived(r, end.other);
}

function simReceived(r, recv) {
	return Object.assign(r, { local: false, ebgp: recv.s.ebgp, end: recv, rid: simRouterId(recv.other.r), peerIp: recv.peerIp });
}

// import at the receiving router: sets status "rejected" and the reason, or applies the inbound policy
function simImport(r) {
	let R = r.end.r, remote = r.end.remote;
	if (r.ebgp && r.path.indexOf(R.asn) >= 0) return Object.assign(r, { status: "rejected", reason: "AS-path loop: the path contains AS " + R.asn });
	if (r.ebgp && R.requiresPolicy && !simHasPolicy(R, remote, "in"))
		return Object.assign(r, { status: "rejected", reason: R.name + " has no inbound policy for " + remote.neighbor + ": FRR (ebgp-requires-policy) accepts nothing" });
	let res = simPolicies(R, remote, "in", r, r.ebgp);
	if (!res.route) return Object.assign(r, { status: "rejected", reason: res.reason });
	if (res.route.lp === undefined) res.route.lp = 100;
	return res.route;
}

// candidates of a router: its networks and what its neighbors announce; then the decision process
function simDecide(R) {
	let table = {}, add = r => (table[r.key] = table[r.key] || []).push(r);
	let rid = simRouterId(R);
	let local = function (c, origin, what) {
		add({ prefix: c, key: simKey(c), path: [], origin: origin, med: 0, lp: 100, nh: null, communities: [], local: true, ebgp: false, rid: rid, peerIp: 0, igp: 0, what: what });
	};
	for (let n of R.networks) {
		let c = parseCidr(n);
		if (!c || c.addr != c.net) continue;
		c = simNet(c);
		let k = simKey(c);
		if (R.importCheck && !(R.fib[k] && R.fib[k].type != "ebgp" && R.fib[k].type != "ibgp")) {
			add({ prefix: c, key: k, path: [], origin: 0, communities: [], local: true, nh: null, status: "rejected", what: "network " + n,
				reason: "network " + n + " is not announced: it is not in the routing table (bgp network import-check)" });
			continue;
		}
		local(c, 0, "network " + n);
	}
	for (let what of R.redistribute) {
		for (let e of R.fibList) {
			if (e.type == what) local(e.c, 2, "redistribute " + what);
		}
	}
	for (let end of R.ends) {
		let send = end.other;
		if (!end.s.up || !send) continue;
		if (simDefaultOriginate(send)) add(simImport(simDefaultRoute(send)));
		for (let k in send.r.best) {
			let res = simExport(send, send.r.best[k]);
			if (res.route) add(simImport(res.route));
		}
	}
	let best = {};
	for (let k in table) {
		let list = table[k];
		for (let r of list) {
			if (r.status == "rejected") continue;
			if (r.local) { r.status = "valid"; continue; }
			let res = simResolve(R, r.nh, k);
			if (!res) {
				r.status = "invalid";
				r.reason = "next hop " + ipToString(r.nh) + " unreachable" + (simLookup(R, r.nh) ? " (FRR does not resolve next hops via the default route)" : "");
			} else {
				r.status = "valid";
				r.igp = res.cost;
			}
		}
		let valid = list.filter(r => r.status == "valid").sort((a, b) => simCompare(a, b).d);
		if (!valid.length) continue;
		best[k] = valid[0];
		valid[0].status = "best";
		valid[0].reason = valid.length == 1 ? "only valid route" : simCompare(valid[0], valid[1]).label;
		for (let r of valid.slice(1)) r.reason = "loses to the best: " + simCompare(valid[0], r).label;
	}
	R.table = table;
	R.best = best;
}

function simSignature(ms) {
	return JSON.stringify(ms.list.map(M => [M.name, Object.keys(M.best || {}).sort().map(function (k) {
		let b = M.best[k];
		return [k, b.path, b.nh, b.lp, b.med, b.end ? b.end.s.key : ""];
	}), M.igp]));
}

/* -------------------- simulation -------------------- */

// opts.down: { sessions: { key: true }, domains: { name: true } }
function bgpSimulate(netkit, bgpAs, opts) {
	opts = opts || {};
	let down = { sessions: (opts.down && opts.down.sessions) || {}, domains: (opts.down && opts.down.domains) || {} };
	let warnings = [];
	let ms = simMachines(netkit, bgpAs, down, warnings);
	let sessions = simSessions(ms, down);
	let routers = ms.list.filter(M => M.eff);
	if (ms.list.some(M => M.router && !M.frr)) warnings.push({ machine: "", text: "Quagga routers are simulated like FRR, without ebgp-requires-policy and network import-check" });
	for (let M of ms.list) { M.best = {}; M.table = {}; M.igp = {}; M.ends = M.ends || []; }

	let prev = "", converged = false, pass;
	for (pass = 1; pass <= SIM_MAX_PASSES; pass++) {
		for (let p of ["rip", "ospf"]) {
			let res = simIgp(ms.list, p);
			for (let M of ms.list) M.igp[p] = res[M.name] || {};
		}
		ms.list.forEach(simBuildFib);
		sessions.forEach(simSessionState);
		for (let R of routers) {
			simDecide(R);
			simBuildFib(R);
		}
		let sig = simSignature(ms);
		if (sig == prev) { converged = true; break; }
		prev = sig;
	}
	ms.list.forEach(simBuildFib);
	// routers without BGP: the AS of the BGP routers their IGP learns routes from
	for (let M of ms.list) {
		if (M.asn || !M.router) continue;
		let names = ["rip", "ospf"].map(p => Object.keys(M.igp[p]).map(k => M.igp[p][k].origin)).reduce((a, b) => a.concat(b), []);
		let from = names.map(n => ms.byName[n]).find(O => O && O.asn);
		if (from) M.asGuess = from.asn;
	}
	if (!converged) warnings.push({ machine: "", text: "BGP did not converge after " + SIM_MAX_PASSES + " rounds (the routes keep changing, an oscillation?): the results show the last round" });
	let owner = {};
	for (let M of ms.list) for (let a of M.addrs) if (owner[a.ip] === undefined) owner[a.ip] = M;
	return { machines: ms.list, byName: ms.byName, routers: routers, sessions: sessions, owner: owner, warnings: warnings, converged: converged, rounds: pass, bgpAs: bgpAs };
}

/* -------------------- queries -------------------- */

function simRoleText(sim, R, r) {
	if (r.local || !r.path.length || !sim.bgpAs) return "";
	let role = asRole(sim.bgpAs, String(R.asn), String(r.path[0]));
	return role ? role + " route, " : "";
}

function simOrigin(r) {
	return r.local ? r.what : r.defaultOriginate ? "default-originate" : "";
}

// rows like show ip bgp: [{ prefix, routes: [{ mark, nh, med, lp, path, from, status, reason }] }]
function bgpSimTable(sim, name) {
	let R = sim.byName[name];
	if (!R || !R.eff) return [];
	return Object.keys(R.table).map(k => R.table[k]).sort((a, b) => a[0].prefix.net - b[0].prefix.net || a[0].prefix.len - b[0].prefix.len).map(list => ({
		prefix: list[0].key,
		routes: list.slice().sort((a, b) => ["best", "valid", "invalid", "rejected"].indexOf(a.status) - ["best", "valid", "invalid", "rejected"].indexOf(b.status)).map(r => ({
			mark: r.status == "best" ? "*>" : r.status == "valid" ? "* " : "  ",
			status: r.status,
			nh: r.local ? "0.0.0.0" : ipToString(r.nh),
			med: r.med === undefined ? "" : r.med,
			lp: r.lp === undefined ? "" : r.lp,
			path: (r.path.join(" ") + " " + SIM_ORIGINS[r.origin]).trim(),
			from: r.local ? simOrigin(r) : r.end.other.r.name + (r.defaultOriginate ? " (default-originate)" : ""),
			reason: (r.status == "best" ? simRoleText(sim, R, r) : "") + (r.reason || "")
		}))
	}));
}

// data plane: follows the forwarding tables router by router
function bgpSimTrace(sim, srcName, dst) {
	let cur = sim.byName[srcName], hops = [], seen = {};
	let res = { src: srcName, dst: ipToString(dst), hops: hops, delivered: false };
	while (cur) {
		if (cur.addrs.some(a => a.ip == dst)) {
			res.delivered = true;
			res.end = cur.name;
			return res;
		}
		if (seen[cur.name]) {
			res.fail = "forwarding loop at " + cur.name;
			return res;
		}
		seen[cur.name] = true;
		let e = simLookup(cur, dst);
		let hop = { m: cur.name, as: cur.asn || cur.asGuess || "", router: cur.router };
		hops.push(hop);
		if (!e) {
			res.fail = cur.name + " has no route to " + ipToString(dst);
			res.end = cur.name;
			res.noRoute = true;
			return res;
		}
		hop.prefix = simKey(e.c);
		hop.type = e.type;
		let via = e.type == "connected" ? { ip: dst, domain: e.domain } : simResolve(cur, e.nh);
		if (!via) {
			res.fail = cur.name + ": next hop " + ipToString(e.nh) + " of " + hop.prefix + " unreachable";
			return res;
		}
		let next = sim.owner[via.ip];
		hop.nh = e.type == "connected" ? "" : ipToString(e.nh);
		hop.via = ipToString(via.ip);
		hop.domain = via.domain;
		let shorter = cur.fibList.filter(x => x !== e && simContains(x.c, dst)).map(x => simKey(x.c));
		hop.reason = simHopReason(sim, cur, e) + (shorter.length ? "; longest match, also " + shorter.join(", ") : "");
		if (e.route) {
			hop.path = e.route.path.join(" ");
			hop.lp = e.route.lp;
			hop.med = e.route.med === undefined ? "" : e.route.med;
		}
		if (!next || !next.addrs.some(a => a.ip == via.ip && a.up && a.domain == via.domain)) {
			res.fail = e.type == "connected" ? "no machine has " + ipToString(dst) + " in " + hop.prefix + " (collision domain " + via.domain + ")"
				: "no machine has the next hop " + hop.via;
			return res;
		}
		hop.next = next.name;
		cur = next;
	}
	return res;
}

function simHopReason(sim, R, e) {
	switch (e.type) {
		case "connected": return "directly connected";
		case "static": return "static route";
		case "rip": return "RIP route, metric " + e.metric + " (from " + e.from + ")";
		case "ospf": return "OSPF route, cost " + e.metric + " (from " + e.from + ")";
	}
	let r = e.route;
	return (e.type == "ibgp" ? "iBGP, " : "eBGP, ") + simRoleText(sim, R, r) + r.reason + (r.lp !== undefined && !/local-pref/.test(r.reason) ? ", local-pref " + r.lp : "");
}

// the ASes crossed by a trace, in order
function bgpSimAsPath(sim, trace) {
	let list = [];
	let push = n => { let M = sim.byName[n], x = M && (M.asn || M.asGuess); if (x && list[list.length - 1] !== x) list.push(x); };
	trace.hops.forEach(h => push(h.m));
	if (trace.end) push(trace.end);
	return list;
}

// the AS-path the traffic follows in the control plane: the AS of the first router that uses a BGP route, then the
// AS-path of that route (prepends removed); null if no BGP route is used
function bgpSimRouteAses(trace) {
	let h = trace.hops.find(x => x.type == "ebgp" || x.type == "ibgp");
	if (!h) return null;
	return [h.as].concat(h.path ? h.path.split(" ").map(Number) : []).filter((x, i, a) => i == 0 || x !== a[i - 1]);
}

// valley-free check on an AS-path (slides: type-1 uphill then downhill, type-2 with one peer-peer edge on top)
function bgpSimValley(bgpAs, ases) {
	if (!bgpAs || !relationsOf(bgpAs).length || ases.length < 2) return null;
	let steps = "";
	for (let i = 0; i + 1 < ases.length; i++) {
		let role = asRole(bgpAs, String(ases[i]), String(ases[i + 1]));
		if (!role) return { status: "unknown", text: "no relationship between AS " + ases[i] + " and AS " + ases[i + 1] + ": cannot check if the path is valley-free" };
		steps += role == "provider" ? "U" : role == "customer" ? "D" : "P";
	}
	if (/^U*D*$/.test(steps)) return { status: "type-1", text: "valley-free (type-1: uphill then downhill)" };
	if (/^U*PD*$/.test(steps)) return { status: "type-2", text: "valley-free (type-2: uphill, one peer-peer edge, downhill)" };
	// a route from a provider or a peer sent to a provider or a peer
	let i = steps.search(/[DP][UP]/);
	return { status: "invalid", text: "NOT valley-free: AS " + ases[i + 1] + " gives transit between AS " + ases[i] + " and AS " + ases[i + 2] };
}

// expected path: router names, or AS numbers compared with the ASes crossed
function bgpSimExpected(sim, trace, text) {
	let want = String(text || "").trim().split(/[\s,>-]+/).filter(t => t);
	if (!want.length) return null;
	let byAs = want.every(t => /^\d+$/.test(t));
	let got = byAs ? bgpSimAsPath(sim, trace).map(String) : trace.hops.map(h => h.m).concat(trace.delivered ? [trace.end] : []);
	for (let i = 0; i < Math.max(want.length, got.length); i++) {
		if (want[i] !== got[i]) {
			return { ok: false, index: i, byAs: byAs, text: "diverges at step " + (i + 1) + ": expected " + (want[i] ? (byAs ? "AS " : "") + want[i] : "the end") + ", the simulation gives "
				+ (got[i] ? (byAs ? "AS " : "") + got[i] : "the end") + (byAs ? "" : " (" + got.join(" > ") + ")") };
		}
	}
	return { ok: true, byAs: byAs, text: "matches the expected path" };
}

// where a prefix goes: for each session direction from a router that has it as best
function bgpSimPropagation(sim, key) {
	let rows = [], origins = [];
	for (let R of sim.routers) {
		for (let r of R.table[key] || []) {
			if (r.local) origins.push({ m: R.name, ok: r.status != "rejected", text: r.reason && r.status == "rejected" ? r.reason : r.what });
		}
	}
	for (let s of sim.sessions) {
		for (let end of s.ends) {
			if (!end.other) continue;
			let P = end.r, R = end.other.r, b = P.best[key];
			let dflt = key == "0.0.0.0/0" && simDefaultOriginate(end);
			if ((!b && !dflt) || (b && b.end && b.end.s === s && !dflt)) continue;	// not sent back where it came from: normal
			let row = { from: P.name, to: R.name, session: s.key, ebgp: s.ebgp };
			rows.push(row);
			if (!s.up) {
				row.status = "down";
				row.reason = "session down: " + s.why;
				continue;
			}
			if (!dflt) {
				let res = simExport(end, b);
				if (!res.route) {
					row.status = "blocked";
					row.reason = "not announced by " + P.name + ": " + res.reason;
					continue;
				}
			}
			let got = (R.table[key] || []).find(r => r.end === end.other);
			row.status = !got ? "blocked" : got.status == "best" ? "best" : got.status == "valid" ? "accepted" : "blocked";
			row.reason = !got ? "not received" : got.status == "rejected" ? "rejected by " + R.name + ": " + got.reason : got.reason;
			if (got && got.status == "best") row.reason = "best at " + R.name + ": " + got.reason;
		}
	}
	return { key: key, origins: origins, rows: rows };
}

// all the prefixes the lab knows (tables of every router) that contain ip, longest first
function bgpSimPrefixesFor(sim, ip) {
	let keys = {};
	for (let R of sim.routers) for (let k in R.table) if (simContains(R.table[k][0].prefix, ip)) keys[k] = R.table[k][0].prefix.len;
	for (let s of sim.sessions) if (s.ends.some(e => simDefaultOriginate(e))) keys["0.0.0.0/0"] = 0;
	return Object.keys(keys).sort((a, b) => keys[b] - keys[a]);
}

// everything the Topology tab shows for a source (name or "" for all routers) and a destination (IP or prefix)
function bgpSimQuery(sim, q) {
	let res = { traces: [], graph: { path: [], nodes: [], overlay: [] } };
	let text = String(q.dest || "").trim();
	if (!text) return res;
	let c = text.indexOf("/") >= 0 ? parseCidr(text) : null, ip = c ? null : parseIp(text);
	if (c) ip = c.len >= 31 ? c.net : c.net + 1;
	if (ip === null || ip === undefined) {
		res.machines = bgpSimMachineAddresses(sim, text);
		if (!res.machines.length) res.error = "'" + text + "' is not an IP address, a prefix or the name of a machine";
		return res;
	}
	res.dst = ipToString(ip);
	if (c) res.prefix = ipToString(c.net) + "/" + c.len;
	let sources = q.source ? [q.source] : sim.machines.filter(M => M.router).map(M => M.name);
	for (let src of sources) {
		if (!sim.byName[src]) continue;
		let t = bgpSimTrace(sim, src, ip);
		t.ases = bgpSimAsPath(sim, t);
		t.route = t.hops.map(h => h.m).concat(t.delivered ? [t.end] : []).join(" > ");
		t.routeAses = bgpSimRouteAses(t);
		t.valley = t.routeAses && bgpSimValley(sim.bgpAs, t.routeAses);
		if (q.source) t.expected = bgpSimExpected(sim, t, q.expected);
		if (t.noRoute) t.lost = bgpSimLost(sim, t.end, ip);
		res.traces.push(t);
		t.hops.forEach(function (h, i) {
			if (!h.next) return;
			res.graph.path.push({ from: h.m, to: h.next, domain: h.domain, label: q.source ? String(i + 1) : "" });
		});
		for (let n of t.hops.map(h => h.m).concat(t.end ? [t.end] : [])) if (res.graph.nodes.indexOf(n) < 0) res.graph.nodes.push(n);
	}
	if (q.propagation) {
		let key = res.prefix || bgpSimPrefixesFor(sim, ip)[0];
		if (key) {
			res.propagation = bgpSimPropagation(sim, key);
			res.graph.overlay = res.propagation.rows.map(r => ({ from: r.from, to: r.to, status: r.status, title: r.reason }));
		}
	}
	return res;
}

// machines whose name starts with text, with their addresses as in the configuration (interfaces, then the
// startup free text) and the collision domain of each: [{ name, addrs: [{ ip, cidr, dev, domain, peers }] }]
function bgpSimMachineAddresses(sim, text) {
	let t = text.toLowerCase();
	return sim.machines.filter(M => M.name.toLowerCase().indexOf(t) == 0).map(M => ({
		name: M.name,
		addrs: M.addrs.map(a => ({
			ip: ipToString(a.ip), cidr: ipToString(a.ip) + "/" + a.c.len, dev: a.dev, domain: a.domain,
			peers: a.domain ? sim.machines.filter(O => O !== M && O.addrs.some(b => b.domain == a.domain)).map(O => O.name) : []
		}))
	}));
}

// why a router has no route: for each prefix containing the destination, the sessions where it stops
function bgpSimLost(sim, name, ip) {
	let keys = bgpSimPrefixesFor(sim, ip);
	if (!keys.length) {
		let notes = [];
		for (let R of sim.routers) for (let k in R.table) for (let r of R.table[k]) if (r.local && r.status == "rejected" && simContains(r.prefix, ip)) notes.push(R.name + ": " + r.reason);
		return [{ text: "no router announces a prefix containing " + ipToString(ip) + (notes.length ? " (" + notes.join("; ") + ")" : "") }];
	}
	return keys.map(function (k) {
		let p = bgpSimPropagation(sim, k);
		let into = p.rows.filter(r => r.to == name && r.status != "best" && r.status != "accepted");
		let blocked = p.rows.filter(r => r.status == "blocked" || r.status == "down");
		let has = sim.routers.filter(R => R.best[k]).map(R => R.name);
		return {
			key: k,
			text: k + (p.origins.length ? " (announced by " + p.origins.map(o => o.m).join(", ") + ")" : "") + ": "
				+ (has.length ? "known by " + has.join(", ") : "nobody has it as best"),
			rows: (into.length ? into : blocked)
		};
	});
}
