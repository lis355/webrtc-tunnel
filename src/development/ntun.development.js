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

	const serverNode = new ntun.Node();
	serverNode.outputConnection = new ntun.outputConnections.DirectOutputConnection(serverNode);
	serverNode.transport = serverTransport;

	const clientNode = new ntun.Node();
	clientNode.inputConnection = new ntun.inputConnections.Socks5InputConnection(clientNode, { port: socks5InputConnectionPort });
	clientNode.transport = clientTransport;

	serverTransport
		.on("connected", () => {
			serverNode.start();
		})
		.on("disconnected", () => {
			serverNode.stop();
		});

	clientTransport
		.on("connected", () => {
			clientNode.start();
		})
		.on("disconnected", () => {
			clientNode.stop();
		});

	serverTransport.start();
	clientTransport.start();

	await urlTests(socks5InputConnectionPort);

	serverTransport.stop();
	clientTransport.stop();
}

run();
