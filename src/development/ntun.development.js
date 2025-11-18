import timersPromises from "timers/promises";

import { config as dotenv } from "dotenv-flow";

import { setLogLevel, LOG_LEVELS } from "../utils/log.js";
import ntun from "../ntun.js";
import urlTests from "./urlTests.js";

dotenv();

setLogLevel(LOG_LEVELS.INFO);

async function run() {
	const transport = "tcp";
	const transportPort = 8081;
	const transportHost = "127.0.0.1";
	const socks5InputConnectionPort = 8080;

	const serverNode = new ntun.Node({ name: "out" });
	serverNode.connection = new ntun.outputConnections.DirectOutputConnection(serverNode);

	const clientNode = new ntun.Node({ name: "in" });
	clientNode.connection = new ntun.inputConnections.Socks5InputConnection(clientNode, { port: socks5InputConnectionPort });

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

			await timersPromises.setTimeout(5000);
			serverNode.transport.start();

			return resolve();
		}),
		new Promise(resolve => {
			const check = () => {
				if (serverNode.workingState === ntun.WORKING_STATE.WORKING &&
					clientNode.workingState === ntun.WORKING_STATE.WORKING &&
					serverNode.transport.isConnected &&
					clientNode.transport.isConnected) {
					serverNode.off("started", check);
					clientNode.off("started", check);
					serverNode.transport.off("connected", check);
					clientNode.transport.off("connected", check);

					return resolve();
				}
			};

			serverNode.on("started", check);
			clientNode.on("started", check);
			serverNode.transport.on("connected", check);
			clientNode.transport.on("connected", check);

			check();
		})
	]);

	await urlTests(socks5InputConnectionPort);

	await Promise.all([
		new Promise(async resolve => {
			clientNode.transport.stop();

			await timersPromises.setTimeout(5000);
			serverNode.transport.stop();

			serverNode.stop();
			clientNode.stop();

			return resolve();
		}),
		new Promise(resolve => {
			const check = () => {
				if (serverNode.workingState === ntun.WORKING_STATE.IDLE &&
					clientNode.workingState === ntun.WORKING_STATE.IDLE &&
					serverNode.transport.workingState === ntun.WORKING_STATE.IDLE &&
					clientNode.transport.workingState === ntun.WORKING_STATE.IDLE) {
					serverNode.off("stopped", check);
					clientNode.off("stopped", check);
					serverNode.transport.off("stopped", check);
					clientNode.transport.off("stopped", check);

					return resolve();
				}
			};

			serverNode.on("stopped", check);
			clientNode.on("stopped", check);
			serverNode.transport.on("stopped", check);
			clientNode.transport.on("stopped", check);

			check();
		})
	]);
}

run();
