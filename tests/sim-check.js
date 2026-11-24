// Runs the simulation tests of tests/tests.html in node. Run: node tests/sim-check.js
const fs = require("fs"), vm = require("vm"), path = require("path");

const html = fs.readFileSync(path.join(__dirname, "tests.html"), "utf8");
const ctx = { console };
vm.createContext(ctx);
// the scripts of the page in order: sources, then the inline ones except the last (it fills the page)
const scripts = [...html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)];
for (const [, src, body] of scripts.slice(0, -1)) {
	const file = src ? path.join(__dirname, src) : "tests.html";
	vm.runInContext(src ? fs.readFileSync(file, "utf8") : body, ctx, { filename: file });
}
const results = vm.runInContext("runRoutingSimTests()", ctx);
const failed = results.filter(r => !r.ok);
for (const r of failed) console.log("FAIL " + r.name + "\n" + r.detail + "\n");
if (failed.length) process.exit(1);
console.log("sim-check: all " + results.length + " tests passed");
