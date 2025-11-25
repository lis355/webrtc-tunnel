import timersPromises from "timers/promises";

import { config as dotenv } from "dotenv-flow";

import { parseTransferRate } from "../../utils/DataRateLimiter.js";
import { setLogLevel, LOG_LEVELS } from "../../utils/log.js";
import ntun from "../../ntun.js";
import urlTests from "../urlTests.js";
import waits from "../waits.js";
import YandexTelemostTransport from "../../transport/ya-telemost/YandexTelemostWebRTCTransport.js";

dotenv();

setLogLevel(LOG_LEVELS.DEBUG);

async function run() {
	const joinId = YandexTelemostTransport.getJoinId(process.env.DEVELOP_YA_TELEMOST_JOIN_ID_OR_LINK);
	const socks5InputConnectionPort = 8080;
	const rateLimitBytesPerSecond = parseTransferRate("250 kbps"); // 0.25 mbps ~ slow 3g

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

	serverNode.transport = new YandexTelemostTransport.YandexTelemostWebRTCTransport({ joinId, ...transportOptions });
	clientNode.transport = new YandexTelemostTransport.YandexTelemostWebRTCTransport({ joinId, ...transportOptions });

	await Promise.all([
		new Promise(async resolve => {
			serverNode.start();
			clientNode.start();

			clientNode.transport.start();

			await timersPromises.setTimeout(3000);

			// serverNode.transport.start();

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

			await timersPromises.setTimeout(5000);

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

run();
