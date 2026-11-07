# Netkit Lab Generator
A tool to configure a Kathará or a Netkit lab and generate all the files you need and the topology graph. 

It works as stand-alone HTML file or using Electron for some advanced capabilities (like the ability to directly run a lab from inside the UI).

![Screenshot (graph)](https://raw.githubusercontent.com/Kidel/Netkit-Lab-Generator/master/images/screencapture-201801143.png)

Simply fill the form and download the bash script or the .zip file with the whole lab. 
It is also possible to export and import the form configuration for future changes.
"Check Lab" lists the problems of the lab before you download it (typos in addresses, interfaces not declared, neighbors that do not exist, ...) and "Copy Script" copies the bash script to the clipboard. Run `node tests/lab-lint-check.js` to test the checks.

Now supports network topology preview (requires a modern browser or the Electrum release).

* [Demo](https://www.kathara.org/tools/nlg/) **(may not always be up to date)**
* [Example configuration](https://raw.githubusercontent.com/Kidel/Netkit-Lab-Generator/master/examples/example_lab.config) (can be imported to generate the files or the graph)
* [BGP policies example](examples/example_bgp_policies.config): prefix-lists (with ge/le), access-lists, as-path access-lists and route-maps applied to the neighbors (import it with "Save & Load" > "Import configuration"). Run `node tests/bgp-policy-check.js` to check the generated configuration.
* [AS relationships example](examples/example_bgp_relationships.config): six ASes (AS1, AS2, AS10, AS20, AS100, AS200) with customer/peer/provider relationships and the policy model "Both" (customer-provider export filter + prefer-customer local-preference). The route-maps generated from the relationships, the models and the primary/backup preference of each eBGP session are proposed in the BGP policies of each router, to be applied, edited or discarded. Run `node tests/bgp-as-check.js` to check them.
* BGP Mode (Topology tab): simulates BGP on the lab configuration (sessions, policies, decision process, an approximate RIP/OSPF) and shows the path from a router to a destination hop by hop, the BGP table of each router with the reason for every rejected route, where an announcement is blocked, valley-free checks when AS relationships are set, and what happens when a session or a link goes down. It approximates FRR: the real check is `show ip bgp`. Open [tests/tests.html](tests/tests.html) in a browser to run its tests (course labs bgp-multi-homed-stub and bgp-multi-homed, forbidden path of the internet hierarchy slides).
* [Screenshot (form)](https://raw.githubusercontent.com/Kidel/Netkit-Lab-Generator/master/images/screencapture-201801261.png)
* [Screenshot (graph)](https://raw.githubusercontent.com/Kidel/Netkit-Lab-Generator/master/images/screencapture-201801143.png)


#### Created by

   * https://github.com/KatharaFramework/Netkit-Lab-Generator/graphs/contributors

### Links

 * [**Kathará Home**](https://www.kathara.org)
 * [**Netkit Home**](http://wiki.netkit.org/index.php/Main_Page)
 * [**Netkit on GitHub**](https://github.com/maxonthegit/netkit-core)

***

### FAQ

* **Q**: How can I make a machine that is both a web server and a name server?
* **A**: Two machines with the same name are considered as the same machine. For any shared file, the configuration lines of the second machine are added right after the ones of the first machine. For any file that is not shared there is no conflict.
