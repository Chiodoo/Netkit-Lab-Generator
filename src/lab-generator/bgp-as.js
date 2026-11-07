/* ---------------------------------------------------------------- */
/* ------------- AS RELATIONSHIPS AND POLICY MODELS --------------- */
/* customer/peer/provider per AS pair and the policy model of each   */
/* AS (labInfo.bgpAs), primary/backup per session (remote.pref).     */
/* They generate route-maps that enter the configuration only once   */
/* the user applies them (remote.auto[in|out]).                      */
/* Policies are the objects of bgp-policy.js and use its generators. */
/* ---------------------------------------------------------------- */

var AS_MODELS = [
	{ value: "none", label: "None" },
	{ value: "cp", label: "Customer-provider" },
	{ value: "pc", label: "Prefer-customer" },
	{ value: "both", label: "Both" }
];

// role of the neighbor AS: "provider" = the neighbor is a provider of this AS
var AS_ROLES = [
	{ value: "", label: "-" },
	{ value: "provider", label: "provider" },
	{ value: "peer", label: "peer" },
	{ value: "customer", label: "customer" }
];

var LINK_PREFS = [
	{ value: "normal", label: "Normal" },
	{ value: "primary", label: "Primary" },
	{ value: "backup", label: "Backup" },
	{ value: "custom", label: "Custom" }
];

var DEFAULT_LOCAL_PREF = { customer: 300, peer: 200, provider: 100 };
var NON_CUSTOMER = "NON-CUSTOMER-ROUTES";

function defaultLinkPref() {
	return { mode: "normal", delta: 10, med: 10, lp: "" };
}

// configurations exported before AS relationships existed
function migrateBgpAs(labInfo) {
	if (!labInfo) return;
	let a = labInfo.bgpAs = labInfo.bgpAs || {};
	if (!Array.isArray(a.relations)) a.relations = [];
	if (!a.ases || typeof a.ases != "object") a.ases = {};
}

function validAsn(v) {
	return hasValue(v) && isUint(String(v).trim(), MAX_UINT32) && +v > 0;
}

// "010" and " 10" are AS 10
function asn(v) {
	return String(+String(v).trim());
}

function asSettings(bgpAs, x) {
	return (bgpAs && bgpAs.ases[x]) || { model: "none", lp: DEFAULT_LOCAL_PREF };
}

/* -------------------- relationships -------------------- */

// { a, b, type: "c2p" (a is a customer of b) | "peer" }, values from imported files are checked here
function relationsOf(bgpAs) {
	return ((bgpAs && bgpAs.relations) || []).filter(r => r && validAsn(r.a) && validAsn(r.b) && asn(r.a) != asn(r.b)
		&& (r.type == "c2p" || r.type == "peer"));
}

// role of AS y seen from AS x
function asRole(bgpAs, x, y) {
	for (let r of relationsOf(bgpAs)) {
		let a = asn(r.a), b = asn(r.b);
		if (r.type == "peer" && ((a == x && b == y) || (a == y && b == x))) return "peer";
		if (r.type == "c2p" && a == x && b == y) return "provider";
		if (r.type == "c2p" && a == y && b == x) return "customer";
	}
	return "";
}

// one relationship per pair: setting a role replaces the previous one, on both sides
function setAsRole(bgpAs, x, y, role) {
	bgpAs.relations = bgpAs.relations.filter(r => !r || !((asn(r.a) == x && asn(r.b) == y) || (asn(r.a) == y && asn(r.b) == x)));
	if (role == "peer") bgpAs.relations.push({ a: x, b: y, type: "peer" });
	if (role == "provider") bgpAs.relations.push({ a: x, b: y, type: "c2p" });
	if (role == "customer") bgpAs.relations.push({ a: y, b: x, type: "c2p" });
}

function addAsRelationError(bgpAs, x, value, role) {
	if (!validAsn(value)) return "the AS number must be between 1 and " + MAX_UINT32;
	let y = asn(value);
	if (y == x) return "AS " + x + " cannot have a relationship with itself";
	if (!role) return "choose provider, peer or customer";
	let old = asRole(bgpAs, x, y);
	if (old) return "AS " + y + " is already a " + old + " of AS " + x + ": change it in its row";
	return "";
}

// ASes of the lab: [{ asn, routers: [machine index], sessions: { asn of eBGP neighbors: true } }] by number
function labAses(netkit) {
	let map = {};
	netkit.forEach(function (m, idx) {
		let bgp = m.type == "router" && m.routing && m.routing.bgp;
		if (!bgp || !bgp.en || !validAsn(bgp.as)) return;
		let x = asn(bgp.as), a = map[x] = map[x] || { asn: x, routers: [], sessions: {} };
		a.routers.push(idx);
		for (let r of bgp.remote || []) {
			if (r && r.neighbor && validAsn(r.as) && asn(r.as) != x) a.sessions[asn(r.as)] = true;
		}
	});
	return Object.keys(map).map(k => map[k]).sort((p, q) => p.asn - q.asn);
}

// rows of the "AS relationships" section; creates the settings of new ASes
function bgpAsView(netkit, bgpAs) {
	let ases = labAses(netkit), inLab = {};
	ases.forEach(a => inLab[a.asn] = true);
	return ases.map(function (a) {
		let settings = bgpAs.ases[a.asn] = bgpAs.ases[a.asn] || { model: "none", lp: Object.assign({}, DEFAULT_LOCAL_PREF) };
		if (!settings.lp) settings.lp = Object.assign({}, DEFAULT_LOCAL_PREF);
		let partners = Object.assign({}, a.sessions);
		for (let r of relationsOf(bgpAs)) {
			if (asn(r.a) == a.asn) partners[asn(r.b)] = true;
			if (asn(r.b) == a.asn) partners[asn(r.a)] = true;
		}
		return {
			asn: a.asn,
			routers: a.routers.map(i => netkit[i].name || "machine " + netkit[i].row),
			settings: settings,
			neighbors: Object.keys(partners).sort((p, q) => p - q)
				.map(y => ({ asn: y, role: asRole(bgpAs, a.asn, y), session: !!a.sessions[y], inLab: !!inLab[y] }))
		};
	});
}

/* -------------------- generated policies -------------------- */

function sameRules(p, q) {
	let key = p => JSON.stringify(sortedRules(p).map(r => [+r.seq, r.action, r.regex]));
	return key(p) == key(q);
}

function linkPref(remote) {
	return remote.pref || defaultLinkPref();
}

// the route-maps the models and the link preferences ask for on the eBGP sessions of a router:
// [{ remote, dir, y (neighbor AS), role, policy, uses (as-path list or null), state, conflict (manual route-map or null) }]
function autoSessions(machine, bgpAs) {
	let bgp = machine.routing.bgp;
	if (!bgpAs || !validAsn(bgp.as)) return [];
	let x = asn(bgp.as), set = asSettings(bgpAs, x);
	let exportRule = set.model == "cp" || set.model == "both", importRule = set.model == "pc" || set.model == "both";
	let num = v => isUint(String(v).trim(), MAX_UINT32) ? +v : NaN;

	// first AS of the path = the neighbor AS the route was learned from, also after iBGP (which does not prepend)
	let blocked = {};
	for (let r of relationsOf(bgpAs)) {
		let a = asn(r.a), b = asn(r.b);
		if (a == x) blocked[b] = true;
		if (b == x && r.type == "peer") blocked[a] = true;
	}
	let asPath = {
		id: "auto-as-path", type: "as-path", name: NON_CUSTOMER, auto: true,
		rules: Object.keys(blocked).sort((p, q) => p - q).map((y, i) => ({ seq: 5 * (i + 1), action: "permit", regex: "^" + y + "_" }))
	};
	// a manual copy (made by "Edit") with the same rules is reused instead of being defined twice
	let twin = bgp.policies.find(p => p.type == "as-path" && p.name == NON_CUSTOMER);
	if (twin && sameRules(twin, asPath)) asPath = twin;
	else if (twin) asPath.name += "-AUTO";

	let sessions = [];
	for (let remote of bgp.remote || []) {
		if (!remote || !remote.neighbor || !validAsn(remote.as) || asn(remote.as) == x) continue;
		let y = asn(remote.as), role = asRole(bgpAs, x, y), pref = linkPref(remote);
		let tag = pref.mode == "backup" ? "-BACKUP" : pref.mode == "custom" ? "-CUSTOM" : "";
		let add = (dir, rules) => sessions.push({ remote: remote, dir: dir, y: y, role: role, name: "AS" + y + tag + "-" + dir.toUpperCase(), rules: rules });

		// inbound: local-preference, steers the outbound traffic
		let lp = importRule && role ? num(set.lp[role]) : null;
		if (pref.mode == "backup") lp = (lp === null ? 100 : lp) - num(pref.delta);
		if (pref.mode == "custom" && hasValue(pref.lp)) lp = num(pref.lp);
		// an invalid value is kept as "invalid": the generator skips the rule with a comment
		if (lp !== null) add("in", [{ seq: 10, action: "permit", matches: [], sets: [{ set: "local-preference", value: lp >= 0 ? String(lp) : "invalid" }] }]);

		// outbound: no routes of peers/providers to peers/providers, MED steers the inbound traffic
		let rules = [];
		if (exportRule && (role == "peer" || role == "provider") && asPath.rules.length)
			rules.push({ seq: 10, action: "deny", matches: [{ match: "as-path", value: asPath.id }], sets: [] });
		let med = pref.mode == "backup" || (pref.mode == "custom" && hasValue(pref.med)) ? num(pref.med) : null;
		if (rules.length || med !== null)
			rules.push({ seq: 10 * (rules.length + 1), action: "permit", matches: [], sets: med === null ? [] : [{ set: "metric", value: med >= 0 ? String(med) : "invalid" }] });
		if (rules.length) add("out", rules);
	}
	sessions.sort((p, q) => (p.dir == "out") - (q.dir == "out"));	// stable: in, then out, in neighbor order

	// one route-map per name; sessions towards the same AS with different rules get -2, -3...
	let byName = {}, manual = bgp.policies.filter(p => p.type == "route-map").map(p => p.name);
	for (let s of sessions) {
		let base = manual.indexOf(s.name) >= 0 ? s.name + "-AUTO" : s.name, name = base, content = JSON.stringify(s.rules);
		for (let k = 2; byName[name] && JSON.stringify(byName[name].rules) != content; k++) name = base + "-" + k;
		s.policy = byName[name] = byName[name] || { id: "auto-route-map-" + name, type: "route-map", name: name, auto: true, rules: s.rules };
		s.uses = s.rules.some(r => r.matches.length) ? asPath : null;
		s.state = (s.remote.auto && s.remote.auto[s.dir]) || "";
		let assigned = s.remote.apply && s.remote.apply["route-map"] && findPolicy(bgp.policies, s.remote.apply["route-map"][s.dir], "route-map");
		s.conflict = s.state != "edited" && assigned ? assigned : null;
	}
	return sessions;
}

// the bgp section the generator writes: the applied route-maps are added to the manual ones
function effectiveBgp(machine, bgpAs) {
	let bgp = machine.routing.bgp;
	let used = autoSessions(machine, bgpAs).filter(s => s.state == "applied" && !s.conflict);
	if (!used.length) return bgp;
	let policies = bgp.policies.slice();
	let add = p => { if (p && policies.indexOf(p) < 0) policies.push(p); };
	used.forEach(s => add(s.uses));
	used.forEach(s => add(s.policy));
	let remote = bgp.remote.map(function (r) {
		let mine = used.filter(s => s.remote === r);
		if (!mine.length) return r;
		let apply = Object.assign({}, r.apply);
		apply["route-map"] = Object.assign({}, apply["route-map"]);
		mine.forEach(s => apply["route-map"][s.dir] = s.policy.id);
		return Object.assign({}, r, { apply: apply });
	});
	return Object.assign({}, bgp, { policies: policies, remote: remote });
}

// the lines the generated route-maps add to the router configuration once applied
function autoPreview(machine, sessions) {
	let live = sessions.filter(s => s.state != "discarded" && s.state != "edited");
	let policies = [];
	live.forEach(s => { if (s.uses && policies.indexOf(s.uses) < 0) policies.push(s.uses); });
	live.forEach(s => { if (policies.indexOf(s.policy) < 0) policies.push(s.policy); });
	return live.map(s => "\tneighbor " + s.remote.neighbor + " route-map " + s.policy.name + " " + s.dir + "\n").join("")
		+ bgpPolicyDefinitions({ policies: policies }, machine.routingSoftware);
}

function autoExplain(machine, s) {
	let policies = machine.routing.bgp.policies.concat(s.uses ? [s.uses, s.policy] : [s.policy]);
	let lines = sortedRules(s.policy).map(r => policyRuleExplain(policies, s.policy, r) || policyRuleError(policies, s.policy, r));
	if (s.uses) lines.push(s.uses.name + ": " + s.uses.rules.map(r => r.regex).join(" or ") + " (routes learned from peers and providers)");
	return lines;
}

// "Edit": the route-map (and its as-path list) becomes a normal policy and this session/direction is no longer generated
function detachAutoSession(machine, s) {
	let bgp = machine.routing.bgp;
	let clone = x => JSON.parse(JSON.stringify(x, (k, v) => k == "$$hashKey" ? undefined : v));
	let newId = () => Math.floor((Math.random() * (1000 ** 5)) + 1);
	let freeName = function (type, name) {
		let base = name.replace(/-AUTO$/, ""), n = base;
		for (let k = 2; bgp.policies.some(p => p.type == type && p.name == n); k++) n = base + "-" + k;
		return n;
	};
	let rules = clone(s.policy.rules);
	if (s.uses && s.uses.auto) {
		let copy = { id: newId(), type: "as-path", name: freeName("as-path", s.uses.name), rules: clone(s.uses.rules) };
		bgp.policies.push(copy);
		rules.forEach(r => r.matches.forEach(m => { if (m.value == s.uses.id) m.value = copy.id; }));
	}
	let routeMap = { id: newId(), type: "route-map", name: freeName("route-map", s.policy.name), rules: rules };
	bgp.policies.push(routeMap);
	s.remote.apply["route-map"][s.dir] = routeMap.id;
	s.remote.auto = Object.assign({ in: "", out: "" }, s.remote.auto);
	s.remote.auto[s.dir] = "edited";
	return routeMap;
}

/* -------------------- checks -------------------- */

// [{ level, machine, as, text, quiet }] for the AS relationships section and, except the quiet ones, Check Lab
function bgpAsIssues(netkit, bgpAs) {
	let issues = [];
	if (!bgpAs) return issues;
	let ases = labAses(netkit), byAsn = {};
	ases.forEach(a => byAsn[a.asn] = a);
	let add = (level, idx, x, text) => issues.push({ level: level, machine: idx, as: x, text: text });
	// about the relationships of an AS without a policy model: they change no configuration, so only
	// the AS relationships section shows them (quiet), not Check Lab
	let asWarning = (idx, x, text) => issues.push({ level: "warning", machine: idx, as: x, text: text, quiet: asSettings(bgpAs, x).model == "none" });
	let name = idx => netkit[idx].name || "machine " + netkit[idx].row;
	let rels = relationsOf(bgpAs);

	for (let a of ases) {
		let set = asSettings(bgpAs, a.asn), first = a.routers[0];
		let related = rels.some(r => asn(r.a) == a.asn || asn(r.b) == a.asn);
		if (set.model != "none" || related) {
			for (let y of Object.keys(a.sessions)) {
				if (!asRole(bgpAs, a.asn, y))
					asWarning(first, a.asn, "AS " + a.asn + " has eBGP sessions with AS " + y + " but no relationship with it: the policy models ignore them");
			}
		}
		if (set.model == "pc" || set.model == "both") {
			let lp = set.lp || {};
			if (!["customer", "peer", "provider"].every(k => isUint(String(lp[k]).trim(), MAX_UINT32)))
				add("error", first, a.asn, "AS " + a.asn + " prefer-customer: the local-preference values must be numbers");
			else if (!(+lp.customer > +lp.peer && +lp.peer > +lp.provider))
				add("error", first, a.asn, "AS " + a.asn + " prefer-customer: the local-preference must be customer > peer > provider");
		}
	}

	// reported once per pair, by the AS of the lab with the smaller number
	for (let r of rels) {
		let p = asn(r.a), q = asn(r.b);
		let x = byAsn[p] && (!byAsn[q] || +p < +q) ? p : q;
		let y = x == p ? q : p;
		if (byAsn[x] && !byAsn[x].sessions[y])
			asWarning(byAsn[x].routers[0], x, "AS " + x + " has a relationship with AS " + y + " but no eBGP session with it");
	}

	// customer -> provider must be a hierarchy
	let up = {}, state = {}, seen = {};
	for (let r of rels) if (r.type == "c2p") (up[asn(r.a)] = up[asn(r.a)] || []).push(asn(r.b));
	let visit = function (x, path) {
		if (state[x] == 1) {
			let cycle = path.slice(path.indexOf(x)).concat(x), key = cycle.slice(1).sort().join(" ");
			if (!seen[key]) {
				seen[key] = true;
				asWarning(byAsn[x] ? byAsn[x].routers[0] : -1, x, "customer-provider cycle: " + cycle.map(c => "AS " + c).join(" is a customer of ")
					+ ", the hierarchy has no top");
			}
			return;
		}
		if (state[x] == 2) return;
		state[x] = 1;
		path.push(x);
		for (let y of up[x] || []) visit(y, path);
		path.pop();
		state[x] = 2;
	};
	Object.keys(up).sort((p, q) => p - q).forEach(x => visit(x, []));

	// generated route-maps of every router
	netkit.forEach(function (m, idx) {
		if (m.type != "router" || !m.routing || !m.routing.bgp.en) return;
		let sessions = autoSessions(m, bgpAs), x = asn(m.routing.bgp.as), set = asSettings(bgpAs, x);
		let pending = sessions.filter(s => !s.state);
		if (pending.length)
			add("warning", idx, x, name(idx) + ": " + pending.length + " auto-generated route-map(s) not applied yet (" + pending.map(s => s.policy.name + " " + s.dir).join(", ")
				+ "), apply or discard them in the BGP policies of " + name(idx));
		for (let s of sessions) {
			if (s.state == "applied" && s.conflict)
				add("error", idx, x, name(idx) + " neighbor " + s.remote.neighbor + ": the auto-generated route-map " + s.policy.name + " " + s.dir
					+ " is applied but route-map " + s.conflict.name + " is assigned too, only one route-map per direction: remove one of the two");
		}
		for (let remote of m.routing.bgp.remote || []) {
			let pref = linkPref(remote);
			if (!remote || !remote.neighbor || pref.mode != "backup" || (set.model != "pc" && set.model != "both")) continue;
			if (asRole(bgpAs, x, asn(remote.as)) == "customer" && +set.lp.customer - +pref.delta <= +set.lp.peer)
				add("warning", idx, x, name(idx) + " neighbor " + remote.neighbor + ": the backup customer link gets local-preference "
					+ (+set.lp.customer - +pref.delta) + ", not above the peers (" + set.lp.peer + "): routes via peers win over it");
		}
	});
	return issues;
}
