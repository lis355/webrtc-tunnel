import childProcess from "node:child_process";

import { config as dotenv } from "dotenv-flow";
import { SocksProxyAgent } from "socks-proxy-agent";
import fetch from "node-fetch";

import ntun from "./ntun.js";

dotenv();

async function run() {
	const transportPort = 8013;
	const transportHost = "127.0.0.1";

	const socks5InputConnectionPort = 8012;

	const serverTransport = new ntun.transports.TCPBufferSocketServerTransport(transportPort);
	// serverTransport
	// 	.on("connected", () => {
	// 		console.log("serverTransport", "connected");
	// 	})
	// 	.on("closed", () => {
	// 		console.log("serverTransport", "closed");
	// 	});

	serverTransport.start();

	const clientTransport = new ntun.transports.TCPBufferSocketClientTransport(transportHost, transportPort);
	// clientTransport
	// 	.on("connected", () => {
	// 		console.log("clientTransport", "connected");
	// 	})
	// 	.on("closed", () => {
	// 		console.log("clientTransport", "closed");
	// 	});

	clientTransport.start();

	await Promise.all([
		new Promise(resolve => serverTransport.once("connected", resolve)),
		new Promise(resolve => clientTransport.once("connected", resolve))
	]);

	async function createOutputNode() {
		const outputNode = new ntun.Node();
		outputNode.outputConnection = new ntun.outputConnections.InternetOutputConnection(outputNode);
		outputNode.transport = serverTransport;

		await outputNode.start();

		return outputNode;
	}

	async function createInputNode() {
		const inputNode = new ntun.Node();
		inputNode.inputConnection = new ntun.inputConnections.Socks5InputConnection(inputNode, { port: socks5InputConnectionPort });
		inputNode.transport = clientTransport;

		await inputNode.start();

		return inputNode;
	}

	const [outputNode, inputNode] = await Promise.all([
		createOutputNode(),
		createInputNode()
	]);

	async function curl(args) {
		return new Promise((resolve, reject) => {
			const child = childProcess.exec(`curl ${args}`);
			child.stdout
				.on("data", data => {
					console.log(data.toString());
				});

			child
				.on("error", error => {
					return reject(error);
				})
				.on("close", () => {
					return resolve();
				});
		});
	}

	await curl("https://jdam.am/api/ip");

	const urls = [
		// "http://jdam.am:8260",
		"https://jdam.am/api/ip",
		"https://api.ipify.org/?format=text",
		"http://jsonip.com/",
		"https://checkip.amazonaws.com/",
		"https://icanhazip.com/"
	];

	const test = async () => {
		console.log("Testing proxy multiplexing...");
		const start = performance.now();

		const requests = urls.map(async url => {
			try {
				const proxy = `socks5://127.0.0.1:${socks5InputConnectionPort}`;
				console.log(`${url} [${proxy}]`);

				const result = await fetch(url, { agent: new SocksProxyAgent(proxy) });
				const text = await result.text();

				console.log(url, text.split("\n")[0], (performance.now() - start) / 1000, "s");
			} catch (error) {
				console.log(error.message);
			}
		});

		await Promise.all(requests);

		console.log("Total time:", (performance.now() - start) / 1000, "s");
	};

	await test();

	await curl(`-x socks5://127.0.0.1:${socks5InputConnectionPort} https://jdam.am/api/ip`);

	await inputNode.stop();
	await outputNode.stop();

	serverTransport.stop();
	clientTransport.stop();
}

run();
