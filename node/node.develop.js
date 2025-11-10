import childProcess from "node:child_process";

import { config as dotenv } from "dotenv-flow";
import { SocksProxyAgent } from "socks-proxy-agent";
import fetch from "node-fetch";

import log from "./utils/log.js";
import ntun from "./ntun.js";

dotenv();

async function exec(str) {
	let stdoutString = "";
	let stderrString = "";

	return new Promise((resolve, reject) => {
		const child = childProcess.exec(str);
		child.stdout
			.on("data", data => {
				data.toString().split("\n").filter(Boolean).forEach(line => {
					console.log("[" + str + "]", line.toString().trim());
				});

				stdoutString += data.toString();
			});

		child.stderr
			.on("data", data => {
				data.toString().split("\n").filter(Boolean).forEach(line => {
					console.error("[" + str + "]", line.toString().trim());
				});

				stderrString += data.toString();
			});

		child
			.on("error", error => {
				return reject(error);
			})
			.on("close", () => {
				return resolve({ stdoutString, stderrString });
			});
	});
}

async function run() {
	const transportPort = 8081;
	const transportHost = "127.0.0.1";
	const socks5InputConnectionPort = 8080;
	const transport = "webSocket";

	let serverTransportClass;
	let clientTransportClass;
	switch (transport) {
		case "tcp":
			serverTransportClass = ntun.transports.TCPBufferSocketServerTransport;
			clientTransportClass = ntun.transports.TCPBufferSocketClientTransport;
			break;
		case "webSocket":
			serverTransportClass = ntun.transports.WebSocketBufferSocketServerTransport;
			clientTransportClass = ntun.transports.WebSocketBufferSocketClientTransport;
			break;
		default:
			throw new Error("Invalid transport");
	}

	const serverTransport = new serverTransportClass(transportPort);
	const serverNode = new ntun.Node();
	serverNode.outputConnection = new ntun.outputConnections.InternetOutputConnection(serverNode);
	serverNode.transport = serverTransport;

	const clientTransport = new clientTransportClass(transportHost, transportPort);
	const clientNode = new ntun.Node();
	clientNode.inputConnection = new ntun.inputConnections.Socks5InputConnection(clientNode, { port: socks5InputConnectionPort });
	clientNode.transport = clientTransport;

	serverTransport
		.on("connected", () => {
			serverNode.start();
		})
		.on("closed", () => {
			serverNode.stop();
		});

	clientTransport
		.on("connected", () => {
			clientNode.start();
		})
		.on("closed", () => {
			clientNode.stop();
		});

	serverTransport.start();
	clientTransport.start();

	// await new Promise(resolve => setTimeout(resolve, 1000));

	// serverTransport.stop();
	// clientTransport.stop();

	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} http://jdam.am:8302`);
	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} https://jdam.am/api/ip`);

	const { stdoutString: externalIp } = await exec("curl -s https://jdam.am/api/ip");

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

	serverTransport.stop();
	clientTransport.stop();
}

run();
