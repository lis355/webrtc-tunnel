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
	const rateLimitBytesPerSecond = 31250; // 250 kbps / 0.25 mbps ~ slow 3g
	let testClientConnectionAttempts = true;

	const serverNode = new ntun.Node({ name: "out" });
	serverNode.connection = new ntun.outputConnections.DirectOutputConnection(serverNode);

	const clientNode = new ntun.Node({ name: "in" });
	clientNode.connection = new ntun.inputConnections.Socks5InputConnection(clientNode, { port: socks5InputConnectionPort });

	global.setLogLevelInfo = () => setLogLevel(LOG_LEVELS.INFO);
	global.setLogLevelDebug = () => setLogLevel(LOG_LEVELS.DEBUG);
	global.serverNode = serverNode;
	global.outConnection = serverNode.connection;
	global.clientNode = clientNode;
	global.inConnection = clientNode.connection;

	const transportOptions = {
		rateLimit: {
			bytesPerSecond: rateLimitBytesPerSecond
		},
		cipher: true
	};

	for (const transport of transports) {
		switch (transport) {
			case "tcp":
				serverNode.transport = new ntun.transports.TCPServerTransport({ port: transportPort, ...transportOptions });
				clientNode.transport = new ntun.transports.TCPClientTransport({ host: transportHost, port: transportPort, ...transportOptions });
				break;

			case "ws":
				serverNode.transport = new ntun.transports.WebSocketServerTransport({ port: transportPort, ...transportOptions });
				clientNode.transport = new ntun.transports.WebSocketClientTransport({ host: transportHost, port: transportPort, ...transportOptions });
				break;

			default:
				throw new Error("Invalid transport");
		}

		global.serverTransport = serverNode.transport;
		global.clientTransport = clientNode.transport;

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

				await timersPromises.setTimeout(3000);

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
