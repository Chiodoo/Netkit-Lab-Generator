var changed = true;

var app = angular.module("napp", []);

app.config(["$compileProvider",
	function ($compileProvider) {
		$compileProvider.aHrefSanitizationWhitelist(/^\s*(https?|local|data):/);
	}
]);

app.controller("nc", function ($location, $anchorScroll, $scope) {

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

	// networks and neighbor IPs offered by the <datalist>s, recomputed only when the lab changes
	$scope.$watch("netkit", function (netkit) {
		$scope.suggest = labSuggestions(netkit);
	}, true);

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

	$scope.makeGraph = function (netkitData) {
		return makeGraph(netkitData);
	};

	$scope.makeGraphIfChanged = function (netkitData) {
		if (changed) {
			changed = false;
			return makeGraph(netkitData);
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
