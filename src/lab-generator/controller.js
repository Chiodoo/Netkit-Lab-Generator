var changed = true;

var app = angular.module("napp", []);

app.config(["$compileProvider",
	function ($compileProvider) {
		$compileProvider.aHrefSanitizationWhitelist(/^\s*(https?|local|data):/);
	}
]);

app.controller("nc", function ($location, $anchorScroll, $scope, $timeout) {

	$scope.app = "include/app.html";
	$scope.labInfo = JSON.clone(labInfo);
	$scope.netkit = [];
	$scope.counter = 0;
	$scope.labInfo.toggle = "enable";

	$scope.scrollTo = function (e, hash) {
		e.preventDefault();
		$location.hash(hash);
		$anchorScroll();
	};

	$scope.addMachine = function () {
		$scope.counter++;
		var p = JSON.clone(backbone);
		p.row = $scope.counter;
		p._uid = Math.floor((Math.random() * (1000 ** 5)) + 1);
		$scope.netkit.push(p);

		changed = true;
	};

	$scope.addMachine();

	$scope.removeMachine = function () {
		if ($scope.netkit.length > 1 && confirm("Are you sure you want to remove the machine?")) {
			$scope.netkit.pop();
			$scope.counter--;

			changed = true;
		}
	};

	$scope.addInterface = function (machine) {
		machine.interfaces.if.push({ "eth": { "number": machine.interfaces.counter } });
		machine.interfaces.counter++;

		changed = true;
	};

	$scope.removeInterface = function (machine) {
		if (machine.interfaces.counter > 1 && confirm("Are you sure you want to remove the interface?")) {
			machine.interfaces.if.pop();
			machine.interfaces.counter--;

			changed = true;
		}
	};

	$scope.addGateway = function (machine) {
		machine.gateways.counter++;
		machine.gateways.gw.push({ "route": "", "if": 0 });
	};

	$scope.removeGateway = function (machine) {
		if (machine.gateways.counter > 1 && confirm("Are you sure you want to remove the gateway?")) {
			machine.gateways.gw.pop();
			machine.gateways.counter--;
		}
	};

	$scope.addFile = function (machine) {
		machine.other.fileCounter++;
		machine.other.files.push({ "name": "", "contents": "" });
	};

	$scope.removeFile = function (machine) {
		if (machine.other.fileCounter > 0 && confirm("Are you sure you want to remove the file?")) {
			machine.other.files.pop();
			machine.other.fileCounter--;
		}
	};

	$scope.addRipNetwork = function (machine) {
		machine.routing.rip.network.push("");
		changed = true;
	};

	$scope.removeRipNetwork = function (machine) {
		if (machine.routing.rip.network.length > 1 && confirm("Are you sure you want to remove the network?")) {
			machine.routing.rip.network.pop();
			changed = true;
		}
	};

	$scope.addRipRoute = function (machine) {
		machine.routing.rip.route.push("");
	};

	$scope.removeRipRoute = function (machine) {
		if (machine.routing.rip.route.length > 1 && confirm("Are you sure you want to remove the route?")) {
			machine.routing.rip.route.pop();
		}
	};

	$scope.addOspfNetwork = function (machine) {
		machine.routing.ospf.network.push("");
		machine.routing.ospf.area.push("0.0.0.0");
		machine.routing.ospf.stub.push(false);

		changed = true;
	};

	$scope.removeOspfNetwork = function (machine) {
		if (machine.routing.ospf.network.length > 1 && confirm("Are you sure you want to remove the network?")) {
			machine.routing.ospf.network.pop();
			machine.routing.ospf.area.pop();
			machine.routing.ospf.stub.pop();

			changed = true;
		}
	};

	$scope.addBgpNetwork = function (machine) {
		machine.routing.bgp.network.push("");

		changed = true;
	};

	$scope.removeBgpNetwork = function (machine) {
		if (machine.routing.bgp.network.length > 1 && confirm("Are you sure you want to remove the network?")) {
			machine.routing.bgp.network.pop();

			changed = true;
		}
	};

	$scope.addBgpNeighbor = function (machine) {
		machine.routing.bgp.remote.push(JSON.clone(backbone.routing.bgp.remote[0]));
	};

	$scope.removeBgpNeighbor = function (machine) {
		if (machine.routing.bgp.remote.length > 1 && confirm("Are you sure you want to remove the neighbor?")) {
			machine.routing.bgp.remote.pop();
		}
	};

	$scope.addBgpRule = function (rules) {
		rules.push("");
	};

	$scope.removeBgpRule = function (rules) {
		if (rules.length > 0 && confirm("Are you sure you want to remove the last rule?")) {
			rules.pop();
		}
	};

	/* ---------- BGP policies (logic in bgp-policy.js) ---------- */

	$scope.POLICY_TYPES = POLICY_TYPES;
	$scope.NEIGHBOR_POLICY_CMDS = NEIGHBOR_POLICY_CMDS;
	$scope.ROUTE_MAP_MATCHES = ROUTE_MAP_MATCHES;
	$scope.ROUTE_MAP_SETS = ROUTE_MAP_SETS;
	$scope.DIRECTIONS = ["in", "out"];

	// networks and neighbor IPs offered by the <datalist>s, auto-generated policies and lab problems,
	// recomputed only when the lab or the AS relationships change
	$scope.$watch(() => [$scope.netkit, $scope.labInfo.bgpAs], function () {
		let netkit = $scope.netkit, bgpAs = $scope.labInfo.bgpAs;
		$scope.suggest = labSuggestions(netkit);
		$scope.asView = bgpAsView(netkit, bgpAs);
		$scope.auto = netkit.map(m => m.type == "router" && m.routing.bgp.en ? autoSessions(m, bgpAs) : []);
		$scope.auto.forEach((list, i) => list.forEach(s => s.explain = autoExplain(netkit[i], s)));
		$scope.autoPreview = netkit.map((m, i) => $scope.auto[i].length ? autoPreview(m, $scope.auto[i]) : "");
		$scope.issues = lintLab(netkit, bgpAs);
		$scope.asIssueList = bgpAsIssues(netkit, bgpAs);	// with the quiet ones, hidden in Check Lab
		$scope.lintErrors = $scope.issues.filter(i => i.level == "error").length;
		$scope.lintWarnings = $scope.issues.length - $scope.lintErrors;
		if ($scope.sim.on) $scope.simRun();
	}, true);

	/* ---------- Check Lab (logic in lint.js) ---------- */

	$scope.goToIssue = function (issue) {
		$scope.showCheck = false;
		if (issue.machine < 0) return;
		toggle_tab("home");
		$location.hash($scope.netkit[issue.machine]._uid);
		$anchorScroll();
	};

	// before downloading or copying the lab
	$scope.labReady = function () {
		return !$scope.lintErrors || confirm("Check Lab found " + $scope.lintErrors + " error(s) in the lab. Continue anyway?");
	};

	$scope.copyScript = function () {
		if (!$scope.labReady()) return;
		let text = $scope.generateScript($scope.netkit, $scope.labInfo);
		let flash = function (msg) {
			$scope.copied = msg;
			$timeout(() => $scope.copied = "", 1500);
		};
		// the clipboard API needs a secure context (https, localhost, file:// in most browsers)
		let fallback = function () {
			let area = document.createElement("textarea");
			area.value = text;
			document.body.appendChild(area);
			area.select();
			let ok = document.execCommand("copy");
			document.body.removeChild(area);
			flash(ok ? "Copied!" : "Copy failed");
		};
		if (navigator.clipboard && window.isSecureContext)
			navigator.clipboard.writeText(text).then(() => $timeout(() => flash("Copied!")), () => $timeout(fallback));
		else fallback();
	};

	/* ---------- AS relationships and policy models (logic in bgp-as.js) ---------- */

	$scope.AS_MODELS = AS_MODELS;
	$scope.AS_ROLES = AS_ROLES;
	$scope.LINK_PREFS = LINK_PREFS;

	$scope.setRole = function (x, n) {
		setAsRole($scope.labInfo.bgpAs, x, n.asn, n.role);
		changed = true;
	};

	$scope.addRelation = function (x, form) {
		form.error = addAsRelationError($scope.labInfo.bgpAs, x, form.asn, form.role);
		if (form.error) return;
		setAsRole($scope.labInfo.bgpAs, x, asn(form.asn), form.role);
		form.asn = form.role = "";
		changed = true;
	};

	$scope.asIssues = x => ($scope.asIssueList || []).filter(i => i.as == x && !/auto-generated route-map/.test(i.text));
	$scope.isEbgp = (machine, remote) => remote.neighbor && validAsn(remote.as) && validAsn(machine.routing.bgp.as) && asn(remote.as) != asn(machine.routing.bgp.as);
	$scope.usesModel = x => ["pc", "both"].indexOf($scope.labInfo.bgpAs.ases[x] && $scope.labInfo.bgpAs.ases[x].model) >= 0;
	$scope.detached = x => [].concat(...$scope.auto.map((list, i) => list.filter(s => s.state == "edited" && asn($scope.netkit[i].routing.bgp.as) == x)
		.map(s => ($scope.netkit[i].name || "machine " + $scope.netkit[i].row) + " neighbor " + s.remote.neighbor + " (AS " + s.y + ") " + s.dir)));

	let setState = (s, state) => s.remote.auto = Object.assign({ in: "", out: "" }, s.remote.auto, { [s.dir]: state });
	$scope.applyAuto = s => setState(s, "applied");
	$scope.discardAuto = s => setState(s, "discarded");
	$scope.restoreAuto = s => setState(s, "");
	$scope.applyAllAuto = list => list.filter(s => !s.state && !s.conflict).forEach(s => setState(s, "applied"));

	$scope.editAuto = function (machine, s) {
		if (confirm("Copy " + s.policy.name + (s.uses && s.uses.auto ? " and " + s.uses.name : "") + " into the policies of "
			+ (machine.name || "this router") + "?\nThe copy is applied to neighbor " + s.remote.neighbor + " " + s.dir
			+ " and is no longer regenerated when relationships, models or preferences change."))
			detachAutoSession(machine, s);
	};

	// one route-map per direction: the manual one goes (deleted too if nothing else uses it), the generated one is applied
	$scope.replaceManual = function (machine, s) {
		let bgp = machine.routing.bgp, manual = s.conflict;
		let alone = policyReferences(bgp, manual).length == 1;
		if (!confirm("Remove route-map " + manual.name + " from neighbor " + s.remote.neighbor + " " + s.dir
			+ (alone ? " and delete it (nothing else uses it)" : "") + ", then apply " + s.policy.name + "?")) return;
		s.remote.apply["route-map"][s.dir] = null;
		if (alone) bgp.policies.splice(bgp.policies.indexOf(manual), 1);
		setState(s, "applied");
	};

	$scope.policiesOfType = function (machine, type) {
		return machine.routing.bgp.policies.filter(p => p.type == type);
	};

	$scope.addPolicy = function (machine, type) {
		let policies = machine.routing.bgp.policies;
		let base = type.replace(/-(\w)/g, (s, c) => c.toUpperCase()), n = 1;
		while (policies.some(p => p.type == type && p.name == base + n)) n++;
		let policy = { id: Math.floor((Math.random() * (1000 ** 5)) + 1), type: type, name: base + n, rules: [] };
		policies.push(policy);
		$scope.addPolicyRule(policy);
	};

	$scope.removePolicy = function (machine, policy) {
		let refs = policyReferences(machine.routing.bgp, policy);
		if (refs.length) {
			alert("Cannot delete " + policy.type + " " + policy.name + ", it is used by:\n- " + refs.join("\n- ") + "\nRemove these references first.");
		} else if (confirm("Are you sure you want to remove the " + policy.type + " " + policy.name + "?")) {
			let policies = machine.routing.bgp.policies;
			policies.splice(policies.indexOf(policy), 1);
		}
	};

	$scope.addPolicyRule = function (policy) {
		let step = policy.type == "route-map" ? 10 : 5;
		let rule = { seq: Math.max(0, ...policy.rules.map(r => +r.seq || 0)) + step, action: "permit" };
		if (policy.type == "prefix-list") Object.assign(rule, { prefix: "", ge: null, le: null });
		if (policy.type == "access-list") Object.assign(rule, { prefix: "", exactMatch: false });
		if (policy.type == "as-path") rule.regex = "";
		if (policy.type == "route-map") Object.assign(rule, { matches: [], sets: [] });
		policy.rules.push(rule);
	};

	$scope.removePolicyRule = function (policy, rule) {
		if (confirm("Are you sure you want to remove the rule with seq " + rule.seq + "?")) {
			policy.rules.splice(policy.rules.indexOf(rule), 1);
		}
	};

	// rules are always shown in seq order: moving a rule swaps its seq with the adjacent one
	$scope.movePolicyRule = function (policy, rule, delta) {
		let sorted = sortedRules(policy);
		let other = sorted[sorted.indexOf(rule) + delta];
		if (other) [rule.seq, other.seq] = [other.seq, rule.seq];
	};

	$scope.policyError = (machine, policy) => policyError(machine.routing.bgp.policies, policy);
	$scope.policyWarning = policyWarning;
	$scope.policyRuleError = (machine, policy, rule) => policyRuleError(machine.routing.bgp.policies, policy, rule);
	$scope.policyRuleWarning = policyRuleWarning;
	$scope.policyRuleExplain = (machine, policy, rule) => policyRuleExplain(machine.routing.bgp.policies, policy, rule);
	$scope.neighborPolicyError = neighborPolicyError;
	$scope.matchListType = match => ROUTE_MAP_MATCHES.find(d => d.match == match).type;
	$scope.setPlaceholder = set => ROUTE_MAP_SETS.find(d => d.set == set).placeholder;

	/* ---------- BGP Mode in the Topology tab (logic in bgp-sim.js) ---------- */

	// what is marked down lives only here: it is not exported with the configuration
	$scope.SIM_NOTE = SIM_NOTE;
	$scope.sim = { on: false, source: "", dest: "", propagation: false, expected: "", selected: "", down: { sessions: {}, domains: {} } };

	$scope.simRun = function () {
		let s = $scope.sim;
		if (!s.on) {
			$scope.simResult = $scope.simView = $scope.simTable = null;
			bgpHighlight(null);
			return;
		}
		let r = $scope.simResult = bgpSimulate($scope.netkit, $scope.labInfo.bgpAs, { down: s.down });
		$scope.simRouters = r.machines.filter(M => M.router).map(M => M.name);
		$scope.simBgpRouters = r.routers.map(M => M.name);
		$scope.simDomains = [].concat(...r.machines.map(M => M.addrs.map(a => a.domain))).filter((d, i, a) => d && a.indexOf(d) == i).sort();
		$scope.simView = bgpSimQuery(r, s);
		$scope.simTable = s.selected && r.byName[s.selected] && r.byName[s.selected].eff ? bgpSimTable(r, s.selected) : null;
		bgpHighlight($scope.simView.graph);
	};

	$scope.simToggle = function () {
		$scope.simRun();
		// the graph gets narrower or wider
		$timeout(function () {
			if (typeof network == "object") {
				network.setSize();
				network.fit();
			}
		});
	};

	$scope.simSelect = function (name) {
		$scope.sim.selected = name;
		$scope.simRun();
	};

	$scope.simSetDest = function (ip) {
		$scope.sim.dest = ip;
		$scope.simRun();
	};

	$scope.simTraceSource = function (name) {
		$scope.sim.source = name;
		$scope.simRun();
	};

	$scope.simSessionsDown = () => ($scope.simResult ? $scope.simResult.sessions.filter(s => !s.up).length : 0);

	bgpGraphClick = function (params) {
		let id = params.nodes[0];
		if (!$scope.sim.on || !id || !/^machine-/.test(id)) return;
		$scope.$apply(() => $scope.simSelect(id.slice("machine-".length)));
	};

	$scope.makeDownload = function (text, filename) {
		var blob = new Blob([text], { type: "text/plain;charset=utf-8" });
		saveAs(blob, filename, true);
	};

	$scope.generateScript = function (netkitData, labInfoData) {
		return makeScript(makeFilesStructure(netkitData, labInfoData));
	};

	$scope.generateConfig = function (netkitData, labInfoData) {
		var all = [{ "labInfo": labInfoData, "netkit": netkitData }];
		return JSON.stringify(all, undefined, 4);
	};

	$scope.generateZip = function (netkitData, labInfoData) {
		return makeZip(makeFilesStructure(netkitData, labInfoData));
	};

	$scope.makeGraph = function (netkitData, reset) {
		return makeGraph(netkitData, reset, $scope.labInfo.bgpAs);
	};

	$scope.makeGraphIfChanged = function (netkitData) {
		if (changed) {
			changed = false;
			return makeGraph(netkitData, false, $scope.labInfo.bgpAs);
		}
	};

	$scope.toggleOVSwitchSelection = function (netkitData, thisType) {
		return netkitData.some(machine => machine.type == "controller") && thisType != "controller";
	};

	$scope.toggleControllerSelection = function (netkitData, thisType) {
		return !netkitData.some(machine => machine.type == "controller") || thisType == "controller";
	};

	$scope.toggleGraphUpdate = function () {
		if ($scope.labInfo.toggle == "disable") {
			$scope.labInfo.toggle = "enable";
		}
		else $scope.labInfo.toggle = "disable";
	};

	$scope.import = function () {
		let fileElement = document.getElementById("file");
		try {
			let filePath = fileElement.files[0];
			if (filePath) {
				let fileReader = new FileReader();
				fileReader.onloadend = function (e) {
					try {
						let app = JSON.parse(e.target.result.substring(e.target.result.indexOf("["))); // rimozione caratteri di codifica prima di '['
						$scope.netkit = app[0].netkit;
						$scope.netkit.forEach(migrateBgpPolicies);
						$scope.counter = $scope.netkit.length;
						$scope.labInfo = app[0].labInfo;
						migrateBgpAs($scope.labInfo);
						$scope.$apply();

						changed = true;
					}
					catch (err) {
						alert("Error: " + err);
					}
				};
				fileElement.value = "";
				fileReader.readAsBinaryString(filePath);
			} else {
				fileElement.click();
			}
		}
		catch (err) {
			alert("Error in File Reader: " + err);
		}
	};
});
