import { config as dotenv } from "dotenv-flow";

import urlTests from "./urlTests.js";
import { WebRTCPeerServerTransport, WebRTCPeerClientTransport } from "../transport/WebRTCTransport.js";
import log from "../utils/log.js";
import ntun from "../ntun.js";

dotenv();

const isDevelopment = Boolean(process.env.VSCODE_INJECTION &&
	process.env.VSCODE_INSPECTOR_OPTIONS);

async function run() {
	const iceServers = JSON.parse(process.env.DEVELOP_WEB_RTC_SERVERS);
	const socks5InputConnectionPort = 8080;

	const serverTransport = new WebRTCPeerServerTransport(iceServers);
	const serverNode = new ntun.Node();
	serverNode.outputConnection = new ntun.outputConnections.InternetOutputConnection(serverNode);
	serverNode.transport = serverTransport;

	const clientTransport = new WebRTCPeerClientTransport(iceServers);
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

	await new Promise(resolve => setTimeout(resolve, 1000));

	clientTransport.start();

	await new Promise(resolve => {
		const check = () => {
			if (serverTransport.socket
				&& clientTransport.socket) return resolve();

			setTimeout(check, 100);
		};

		check();
	});

	await urlTests(socks5InputConnectionPort);

	serverTransport.stop();
	clientTransport.stop();
}

run();
