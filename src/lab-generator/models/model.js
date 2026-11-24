var labInfo = {
	description: "",
	version: "",
	author: "",
	email: "",
	web: "",
	bgpAs: { relations: [], ases: {} }	// AS relationships and policy models, see bgp-as.js
};

var backbone = {
	name: "",
	row: 1,
	type: "terminal",
	routingSoftware: "frr",
	interfaces: {
		counter: 1,
		if: [{
			eth: {
				number: 0,
				domain: ""
			},
			ip: ""
		}],
		free: ""
	},
	gateways: {
		counter: 1,
		gw: [{
			route: "",
			if: 0
		}]
	},
	pc: {
		dns: "-"
	},
	ws: {
		userdir: false
	},
	ns: {
		recursion: true,
		authority: true
	},
	other: {
		image: "",
		files: [],
		fileCounter: 0
	},
	ryu: {
		stp: false,
		rest: true,
		topology: true,
		custom: ""
	},
	routing: {
		loopback: { en: false, ip: "" },	// ip address add <ip>/32 dev lo:0 in the startup, see loopbackIp in bgp-policy.js
		rip: {
			en: false,
			connected: false,
			ospf: false,
			bgp: false,
			static: false,
			rmap: {},	// rmap[source] = id of the route-map of "redistribute <source>", see REDISTRIBUTE in bgp-policy.js
			network: [""],
			route: [""],
			free: ""
		},
		ospf: {
			en: false,
			connected: false,
			rip: false,
			bgp: false,
			static: false,
			rmap: {},
			if: [],
			network: [""],
			area: ["0.0.0.0"],
			stub: [false],
			free: ""
		},
		bgp: {
			en: false,
			as: "",
			noEbgpRequiresPolicy: false,
			noNetworkImportCheck: false,
			ebgpToIgp: true,	// "Redistribute eBGP routes into IGP (standard)", see ebgpRedistribution in bgp-as.js
			network: [""],
			connected: false,	// redistribute
			static: false,
			rip: false,
			ospf: false,
			rmap: {},
			remote: [{
				neighbor: "",
				as: "",
				description: "",
				updateSource: "",	// an address of this router
				nextHopSelf: false,
				loopback: false,	// "Peer via loopback": preset of updateSource (own loopback) and nextHopSelf
				defaultOriginate: false,
				apply: emptyApply(),	// apply[cmd][in|out] = id of a policy
				pref: defaultLinkPref(),	// primary/backup of the eBGP session, see bgp-as.js
				auto: { in: "", out: "" }	// generated route-map: "" proposed, applied, discarded, edited
			}],
			policies: [],	// { id, type, name, rules: [] }, see bgp-policy.js
			free: ""
		},
		frr: {
			free: ""
		}
	}
};