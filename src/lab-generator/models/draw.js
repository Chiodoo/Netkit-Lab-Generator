const
	LENGTH_MAIN = 350,
	LENGTH_SERVER = 150,
	LENGTH_SUB = 50,
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
      smooth: {
        type: "dynamic"
      },
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

	network = new vis.Network(container, data, options);

	// labels hang off their machine/domain through LENGTH_CLOSE edges
	let labels = {};
	for (let e of edges)
		if (e.length == LENGTH_CLOSE) (labels[e.from] = labels[e.from] || []).push(e.to);

	// fixed layout has no physics to pull the labels along, so drag them with their node.
	// ponytail: pushes into vis 4.15 internal drag state, recheck if vis is upgraded
	network.on("dragStart", params => {
		if (!document.getElementById("fixedLayout").checked) return;
		let drag = network.interactionHandler.drag;
		for (let id of params.nodes)
			for (let label of labels[id] || []) {
				if (params.nodes.includes(label)) continue;
				let node = network.body.nodes[label];
				drag.selection.push({ id: label, node, x: node.x, y: node.y, xFixed: false, yFixed: false });
			}
	});

	if (keep) return setNetworkOptions();
	document.getElementById("smoothEnabled").checked = true;
	document.getElementById("smoothType").value = "dynamic";
	document.getElementById("fixedLayout").checked = false;
	document.getElementById("physicsGravitationalConstant").value = -1200;
	document.getElementById("physicsGravitationalConstantValue").value = -1200;
}
