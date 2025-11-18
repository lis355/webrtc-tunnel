import { config as dotenv } from "dotenv-flow";

import { log } from "../utils/log.js";
import ntun from "../ntun.js";
import urlTests from "./urlTests.js";

dotenv();

async function run() {
	const transportPort = 8081;
	const transportHost = "127.0.0.1";
	const socks5InputConnectionPort = 8080;
	const transport = "tcp";

	let serverTransport;
	let clientTransport;
	switch (transport) {
		case "tcp":
			serverTransport = new ntun.transports.TCPBufferSocketServerTransport(transportPort);
			clientTransport = new ntun.transports.TCPBufferSocketClientTransport(transportHost, transportPort);
			break;
		case "webSocket":
			serverTransport = new ntun.transports.WebSocketBufferSocketServerTransport(transportPort);
			clientTransport = new ntun.transports.WebSocketBufferSocketClientTransport(transportHost, transportPort);
			break;
		default:
			throw new Error("Invalid transport");
	}

	const serverNode = new ntun.Node({ name: "out" });
	serverNode.connection = new ntun.outputConnections.DirectOutputConnection(serverNode);
	serverNode.transport = serverTransport;

	const clientNode = new ntun.Node({ name: "in" });
	clientNode.connection = new ntun.inputConnections.Socks5InputConnection(clientNode, { port: socks5InputConnectionPort });
	clientNode.transport = clientTransport;

	serverNode.start();
	clientNode.start();

	serverTransport.start();
	clientTransport.start();

	await new Promise(resolve => {
		const check = () => {
			if (serverNode.workingState === ntun.WORKING_STATE.WORKING &&
				clientNode.workingState === ntun.WORKING_STATE.WORKING &&
				serverTransport.isConnected &&
				clientTransport.isConnected) {
				serverNode.off("started", check);
				clientNode.off("started", check);
				serverTransport.off("connected", check);
				clientTransport.off("connected", check);

				return resolve();
			}
		};

		serverNode.on("started", check);
		clientNode.on("started", check);
		serverTransport.on("connected", check);
		clientTransport.on("connected", check);

		check();
	});

	await urlTests(socks5InputConnectionPort);

	serverTransport.stop();
	clientTransport.stop();

	serverNode.stop();
	clientNode.stop();

	await new Promise(resolve => {
		const check = () => {
			if (serverNode.workingState === ntun.WORKING_STATE.IDLE &&
				clientNode.workingState === ntun.WORKING_STATE.IDLE &&
				serverTransport.workingState === ntun.WORKING_STATE.IDLE &&
				clientTransport.workingState === ntun.WORKING_STATE.IDLE) {
				serverNode.off("stopped", check);
				clientNode.off("stopped", check);
				serverTransport.off("stopped", check);
				clientTransport.off("stopped", check);

				return resolve();
			}
		};

		serverNode.on("stopped", check);
		clientNode.on("stopped", check);
		serverTransport.on("stopped", check);
		clientTransport.on("stopped", check);

		check();
	});
}

run();
