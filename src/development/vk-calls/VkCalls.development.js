import timersPromises from "timers/promises";

import { config as dotenv } from "dotenv-flow";

import { setLogLevel, LOG_LEVELS } from "../../utils/log.js";
import exec from "../exec.js";
import ntun from "../../ntun.js";
import VkTransport from "../../transport/vk-calls/VkTransport.js";
import waits from "../waits.js";

dotenv();

setLogLevel(LOG_LEVELS.INFO);

async function run() {
	const joinId = VkTransport.getJoinId(process.env.DEVELOP_VK_JOIN_ID_OR_LINK);
	const socks5InputConnectionPort = 8080;
	const rateLimitBytesPerSecond = 31250; // 250 kbps / 0.25 mbps ~ slow 3g

	const serverNode = new ntun.Node();
	serverNode.connection = new ntun.outputConnections.DirectOutputConnection(serverNode);

	const clientNode = new ntun.Node();
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
		cipher: false // шифрование происходит в VkCallSignalServerTransport при обмене сообщениями
	};

	serverNode.transport = new VkTransport.VkCallSignalServerTransport({ joinId, ...transportOptions });
	clientNode.transport = new VkTransport.VkCallSignalServerTransport({ joinId, ...transportOptions });

	await Promise.all([
		new Promise(async resolve => {
			serverNode.start();
			clientNode.start();

			clientNode.transport.start();

			await timersPromises.setTimeout(3000);

			serverNode.transport.start();

			return resolve();
		}),
		waits.waitForStarted(serverNode),
		waits.waitForStarted(clientNode),
		waits.waitForConnected(serverNode.transport),
		waits.waitForConnected(clientNode.transport)
	]);

	// await urlTests(socks5InputConnectionPort);

	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} http://jdam.am:8302`);
	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} https://jdam.am/api/ip`);

	clientNode.transport.stop();
	await waits.waitForStopped(clientNode.transport);

	// await timersPromises.setTimeout(3000);

	clientNode.transport.start();

	await Promise.all([
		waits.waitForConnected(serverNode.transport),
		waits.waitForConnected(clientNode.transport)
	]);

	await timersPromises.setTimeout(3000);

	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} http://jdam.am:8302`);
	await exec(`curl -s -x socks5://127.0.0.1:${socks5InputConnectionPort} https://jdam.am/api/ip`);

	await Promise.all([
		new Promise(async resolve => {
			clientNode.transport.stop();
			serverNode.transport.stop();

			return resolve();
		}),
		waits.waitForStopped(serverNode.transport),
		waits.waitForStopped(clientNode.transport)
	]);

	await Promise.all([
		new Promise(async resolve => {
			serverNode.stop();
			clientNode.stop();

			return resolve();
		}),
		waits.waitForStopped(serverNode),
		waits.waitForStopped(clientNode)
	]);
}

run();
