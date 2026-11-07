const
	LENGTH_MAIN = 350,
	LENGTH_SERVER = 150,
	LENGTH_SUB = 80,
	LENGTH_CLOSE = 0.0001,
	WIDTH_SCALE = 3,
	GREEN = "green",
	RED = "#C5000B",
	ORANGE = "#f1db8d",
	GRAY = "gray",
	LGRAY = "#dddddd",
	LLGRAY = "#efefef",
	WHITE = "#fafafa",
	BLUE = "#2B7CE9",
	BLACK = "#2B1B17";

const DIR = "src/static/images/";

// image nodes get a highlighted box only while selected
function imageGroup(file) {
	const NONE = "rgba(0,0,0,0)";
	return {
		image: DIR + file,
		shape: "image",
		size: 35,
		font: { strokeWidth: 5, strokeColor: "white" },	// the name stays readable over the edges
		shapeProperties: { useBorderWithImage: true },
		borderWidthSelected: 3,
		color: {
			border: NONE, background: NONE,
			hover: { border: NONE, background: NONE },
			highlight: { border: BLUE, background: "#d2e5ff" }
		}
	};
}

// Called when the Visualization API is loaded.
// keep: reuse the controls' current state instead of resetting them to defaults
function draw(nodes, edges, keep) {
	let container = document.getElementById("mynetwork");

	let data = {
		nodes,
		edges
	};

	let options = {
		nodes: {
			font: { size: 22 },
			scaling: {
				min: 16,
				max: 32,
				label: { min: 20, max: 28, maxVisible: 40 }
			}
		},
		edges: {
			smooth: false,	// "Straight", the default of the controls
			color: BLACK
		},
		physics: {
			enabled: true,
			barnesHut: { gravitationalConstant: -1200 }
		},
    interaction: {
      multiselect: true
    },
		groups: {
			"terminal": imageGroup("terminal.png"),
			"router": imageGroup("router.png"),
			"ns": imageGroup("nameserver.png"),
			"ws": Object.assign(imageGroup("webserver.png"), { value: 8 }),
			"switch": imageGroup("switch.png"),
			"controller": imageGroup("controller.png"),
			"other": imageGroup("other.png"),
			"domain": {
				color: BLACK,
				font: { color: "#dddddd" }
			},
			"eth": {
				color: WHITE,
				shape: "box"
			},
			"domain-ip": {
				color: LGRAY,
				shape: "box"
			},
			"ospf": {
				color: ORANGE,
				shape: "box"
			},
			"rip": {
				color: ORANGE,
				shape: "box"
			},
			"bgp": {
				color: ORANGE,
				shape: "box"
			}
		}
	};

	// a new graph is laid out by physics and then fixed; a redraw keeps the current mode
	let fixed = !keep || document.getElementById("fixedLayout").checked;
	// machines placed before stay put while physics places the new ones
	if (keep && fixed)
		for (let n of nodes) if (n.x !== undefined && isMachine(n.id)) n.fixed = true;
	if (!keep) layoutOffsets = {};
	layoutRules = makeLayoutRules(nodes, edges);

	network = new vis.Network(container, data, options);

	// fixed layout: whatever is dragged together with the machines is put back in its place at once
	let follow = params => { if (document.getElementById("fixedLayout").checked) applyLayout(params.nodes); };
	network.on("dragging", follow);
	network.on("dragEnd", follow);

	if (fixed) network.once("stabilizationIterationsDone", function () {
		document.getElementById("fixedLayout").checked = true;
		setNetworkOptions();
	});

	if (keep) {
		if (!fixed) setNetworkOptions();
		return;
	}
	document.getElementById("smoothEnabled").checked = true;
	document.getElementById("smoothType").value = "straight";
	document.getElementById("fixedLayout").checked = false;
	document.getElementById("physicsGravitationalConstant").value = -1200;
	document.getElementById("physicsGravitationalConstantValue").value = -1200;
}

/* ---------------- fixed layout ---------------- */
// only the machines are placed (by hand): a collision domain sits in the middle of its machines (a LAN of a
// single machine sticks out of it), the interfaces on the links next to their machine, the labels next to their
// node. Dragging one of these shifts it from its place; the shift is kept until Reset.

var layoutRules = { domains: {}, eths: {}, labels: {} };
var layoutOffsets = {};	// node id -> { x, y } moved by hand

function isMachine(id) {
	return /^machine-/.test(id);
}

function makeLayoutRules(nodes, edges) {
	let group = {}, rules = { domains: {}, eths: {}, labels: {} };
	for (let n of nodes) group[n.id] = n.group;
	for (let e of edges) {
		if (group[e.to] == "eth") {
			let eth = rules.eths[e.to] = rules.eths[e.to] || {};
			if (group[e.from] == "domain") eth.domain = e.from;
			else eth.machine = e.from;
		} else if (e.length == LENGTH_CLOSE) {
			(rules.labels[e.from] = rules.labels[e.from] || []).push(e.to);
		}
	}
	for (let id in rules.eths) {
		let eth = rules.eths[id];
		if (!eth.domain || !eth.machine) continue;
		let members = rules.domains[eth.domain] = rules.domains[eth.domain] || [];
		if (members.indexOf(eth.machine) < 0) members.push(eth.machine);
	}
	return rules;
}

// dragged: ids being dragged by hand, their shift is updated instead of their position
function applyLayout(dragged) {
	let nodes = network.body.nodes, rules = layoutRules;
	dragged = dragged || [];
	let place = function (id, x, y) {
		let n = nodes[id];
		if (!n) return;
		if (dragged.indexOf(id) >= 0) {
			if (!isMachine(id)) layoutOffsets[id] = { x: n.x - x, y: n.y - y };
			return;
		}
		let o = layoutOffsets[id] || { x: 0, y: 0 };
		n.x = x + o.x;
		n.y = y + o.y;
	};
	let unit = (dx, dy) => { let l = Math.hypot(dx, dy); return l ? { x: dx / l, y: dy / l, l: l } : { x: 0, y: -1, l: 0 }; };

	// machines linked to each machine, to point its single-machine LANs away from them
	let near = {};
	for (let d in rules.domains) {
		for (let m of rules.domains[d]) for (let o of rules.domains[d]) if (m != o) (near[m] = near[m] || []).push(o);
	}
	let stubs = {};
	for (let d in rules.domains) {
		let members = rules.domains[d].filter(m => nodes[m]);
		if (members.length == 1) (stubs[members[0]] = stubs[members[0]] || []).push(d);
		else if (members.length) place(d, members.reduce((s, m) => s + nodes[m].x, 0) / members.length, members.reduce((s, m) => s + nodes[m].y, 0) / members.length);
	}
	for (let m in stubs) {
		let me = nodes[m], others = (near[m] || []).filter(o => nodes[o]);
		let cx = others.length ? others.reduce((s, o) => s + nodes[o].x, 0) / others.length : me.x;
		let cy = others.length ? others.reduce((s, o) => s + nodes[o].y, 0) / others.length : me.y + 1;
		let dir = unit(me.x - cx, me.y - cy), base = Math.atan2(dir.y, dir.x);
		stubs[m].forEach(function (d, k) {
			let a = base + (k - (stubs[m].length - 1) / 2) * 0.7;
			place(d, me.x + 140 * Math.cos(a), me.y + 140 * Math.sin(a));
		});
	}
	// interface: on the link near its machine, beside the line so that the machine name below the icon stays free
	for (let id in rules.eths) {
		let eth = rules.eths[id], m = nodes[eth.machine], d = nodes[eth.domain];
		if (!m || !d) continue;
		let u = unit(d.x - m.x, d.y - m.y), r = Math.min(65, u.l * 0.4);
		place(id, m.x + u.x * r - u.y * 45, m.y + u.y * r + u.x * 45);
	}
	// labels of a machine above it, the subnet of a domain beside its links (right of vertical ones, below horizontal ones)
	for (let parent in rules.labels) {
		let p = nodes[parent];
		if (!p) continue;
		let members = (rules.domains[parent] || []).filter(m => nodes[m]);
		let vertical = members.reduce((s, m) => s + Math.abs(nodes[m].y - p.y) - Math.abs(nodes[m].x - p.x), 0) > 0;
		rules.labels[parent].forEach(function (id, k) {
			if (isMachine(parent)) place(id, p.x, p.y - 75 - 45 * k);
			else if (vertical) place(id, p.x + 30 + (nodes[id] && nodes[id].shape.width || 140) / 2, p.y + 30 * k);
			else place(id, p.x, p.y + 35 + 30 * k);
		});
	}
	network.redraw();
}
