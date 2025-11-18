import { SocksProxyAgent } from "socks-proxy-agent";
import chalk from "chalk";
import fetch from "node-fetch";

import { createLog } from "../utils/log.js";
import exec from "./exec.js";

const log = createLog("[url-tests]");

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
		log("Start testing");

		const start = performance.now();

		const requests = urls.map(async url => {
			try {
				const proxy = `socks5://127.0.0.1:${socks5InputConnectionPort}`;
				// log(`${url} [${proxy}]`);

				const result = await fetch(url, { agent: new SocksProxyAgent(proxy) });
				const text = (await result.text()).trim().split("\n")[0];

				if (externalIp !== text) throw new Error(`Bad ip response, expected: ${externalIp}, actual: ${text}`);

				log(url, chalk.magenta(text), ((performance.now() - start) / 1000).toFixed(2), "s");
			} catch (error) {
				log(url, chalk.red(error.message));
			}
		});

		await Promise.all(requests);

		log("Total time:", ((performance.now() - start) / 1000).toFixed(2), "s");
	};

	await test();
}
