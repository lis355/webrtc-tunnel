import { SocksProxyAgent } from "socks-proxy-agent";
import fetch from "node-fetch";

import exec from "./exec.js";

export default async function urlTests(socks5InputConnectionPort) {
	const { stdoutString: externalIp } = await exec("curl -s http://jdam.am:8302");

	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} http://jdam.am:8302`);
	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} https://jdam.am/api/ip`);

	const urls = [
		"http://jdam.am:8302",
		"https://jdam.am/api/ip",
		"https://api.ipify.org/?format=text",
		"https://checkip.amazonaws.com/",
		"https://icanhazip.com/"
	];

	const test = async () => {
		console.log("Testing proxy multiplexing...");

		const start = performance.now();

		const requests = urls.map(async url => {
			try {
				const proxy = `socks5://127.0.0.1:${socks5InputConnectionPort}`;
				// console.log(`${url} [${proxy}]`);

				const result = await fetch(url, { agent: new SocksProxyAgent(proxy) });
				const text = (await result.text()).trim();

				if (externalIp !== text) throw new Error(`Bad ip response, expected: ${externalIp}, actual: ${text}`);

				console.log(url, text.split("\n")[0], (performance.now() - start) / 1000, "s");
			} catch (error) {
				console.log(error.message);
			}
		});

		await Promise.all(requests);

		console.log("Total time:", (performance.now() - start) / 1000, "s");
	};

	await test();
}
