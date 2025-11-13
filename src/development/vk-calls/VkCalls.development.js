import { config as dotenv } from "dotenv-flow";

import getJoinId from "../../transport/vk-calls/getJoinId.js";
import log from "../../utils/log.js";
import ntun from "../../ntun.js";
import urlTests from "../urlTests.js";
import VkCallSignalServerTransport from "../../transport/vk-calls/VkCallSignalServerTransport.js";

dotenv();

async function run() {
	const joinId = getJoinId(process.env.DEVELOP_VK_JOIN_ID_OR_LINK);
	const socks5InputConnectionPort = 8080;

	const serverTransport = new VkCallSignalServerTransport(joinId);
	const serverNode = new ntun.Node();
	serverNode.outputConnection = new ntun.outputConnections.InternetOutputConnection(serverNode);
	serverNode.transport = serverTransport;

	const clientTransport = new VkCallSignalServerTransport(joinId);
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
