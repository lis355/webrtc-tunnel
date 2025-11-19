import timersPromises from "timers/promises";

import { config as dotenv } from "dotenv-flow";

import { setLogLevel, LOG_LEVELS } from "../utils/log.js";
import ntun from "../ntun.js";
import urlTests from "./urlTests.js";
import waits from "./waits.js";

dotenv();

setLogLevel(LOG_LEVELS.INFO);

async function run() {
	const transports = ["tcp", "ws"];
	const transportPort = 8081;
	const transportHost = "127.0.0.1";
	const socks5InputConnectionPort = 8080;
	let testClientConnectionAttempts = true;

	const serverNode = new ntun.Node({ name: "out" });
	serverNode.connection = new ntun.outputConnections.DirectOutputConnection(serverNode);

	const clientNode = new ntun.Node({ name: "in" });
	clientNode.connection = new ntun.inputConnections.Socks5InputConnection(clientNode, { port: socks5InputConnectionPort });

	for (const transport of transports) {
		switch (transport) {
			case "tcp":
				serverNode.transport = new ntun.transports.TCPBufferSocketServerTransport(transportPort);
				clientNode.transport = new ntun.transports.TCPBufferSocketClientTransport(transportHost, transportPort);
				break;

			case "ws":
				serverNode.transport = new ntun.transports.WebSocketBufferSocketServerTransport(transportPort);
				clientNode.transport = new ntun.transports.WebSocketBufferSocketClientTransport(transportHost, transportPort);
				break;

			default:
				throw new Error("Invalid transport");
		}

		await Promise.all([
			new Promise(async resolve => {
				serverNode.start();
				clientNode.start();

				clientNode.transport.start();

				if (testClientConnectionAttempts) await timersPromises.setTimeout(5000);

				serverNode.transport.start();

				return resolve();
			}),
			waits.waitForStarted(serverNode),
			waits.waitForStarted(clientNode),
			waits.waitForConnected(serverNode.transport),
			waits.waitForConnected(clientNode.transport)
		]);

		await urlTests(socks5InputConnectionPort);

		await Promise.all([
			new Promise(async resolve => {
				clientNode.transport.stop();
				// await timersPromises.setTimeout(5000);
				serverNode.transport.stop();

				serverNode.stop();
				clientNode.stop();

				return resolve();
			}),
			waits.waitForStopped(serverNode),
			waits.waitForStopped(clientNode),
			waits.waitForStopped(serverNode.transport),
			waits.waitForStopped(clientNode.transport)
		]);
	}
}

run();
