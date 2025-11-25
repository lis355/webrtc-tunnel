import timersPromises from "timers/promises";

import { config as dotenv } from "dotenv-flow";

import { setLogLevel, LOG_LEVELS } from "../../utils/log.js";
import getJoinId from "../../transport/vk-calls/getJoinId.js";
import ntun from "../../ntun.js";
import urlTests from "../urlTests.js";
import VkTransport from "../../transport/vk-calls/VkTransport.js";

dotenv();

setLogLevel(LOG_LEVELS.INFO);

async function run() {
	const joinId = getJoinId(process.env.DEVELOP_VK_JOIN_ID_OR_LINK);
	const socks5InputConnectionPort = 8080;
	const rateLimitBytesPerSecond = 31250; // 250 kbps / 0.25 mbps ~ slow 3g
	const testClientConnectionAttempts = true;

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
		cipher: true
	};

	serverNode.transport = new VkTransport.VkWebRTCTransport({ joinId, ...transportOptions });
	clientNode.transport = new VkTransport.VkWebRTCTransport({ joinId, ...transportOptions });

	await Promise.all([
		new Promise(async resolve => {
			serverNode.start();
			clientNode.start();

			clientNode.transport.start();

			if (testClientConnectionAttempts) await timersPromises.setTimeout(5000);

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

			if (testClientConnectionAttempts) await timersPromises.setTimeout(5000);

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
