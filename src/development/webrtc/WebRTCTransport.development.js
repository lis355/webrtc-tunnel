import { config as dotenv } from "dotenv-flow";

import { log, setLogLevel, LOG_LEVELS } from "../../utils/log.js";
import ntun from "../../ntun.js";
import urlTests from "../urlTests.js";
import waits from "../waits.js";
import WebRTCTransport from "../../transport/webrtc/WebRTCTransport.js";

dotenv();

// Free TURN servers for testing
// https://dashboard.metered.ca/

// WebRTC servers tester
// https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/

setLogLevel(LOG_LEVELS.DETAILED);

async function run() {
	const iceServers = JSON.parse(process.env.DEVELOP_WEB_RTC_SERVERS);
	const socks5InputConnectionPort = 8080;

	const serverNode = new ntun.Node();
	serverNode.connection = new ntun.outputConnections.DirectOutputConnection(serverNode);
	serverNode.transport = new WebRTCTransport.WebRTCPeerServerTransport(iceServers);

	const clientNode = new ntun.Node();
	clientNode.connection = new ntun.inputConnections.Socks5InputConnection(clientNode, { port: socks5InputConnectionPort });
	clientNode.transport = new WebRTCTransport.WebRTCPeerClientTransport(iceServers);

	serverNode.transport
		.on("error", error => {
			log(error.message);

			serverNode.transport.stop();
		})
		.on("sdp.offer", async sdp => {
			log("offer created");

			await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/offer", {
				method: "POST",
				body: JSON.stringify(sdp)
			});

			const waitForAnswer = async () => {
				log("waitForAnswer");

				const response = await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/answer", {
					method: "GET"
				});

				if (response.status === 200) {
					const sdpAnswer = await response.json();
					serverNode.transport.setAnswer(sdpAnswer);

					log("answer settled");
				} else {
					setTimeout(waitForAnswer, 1000);
				}
			};

			waitForAnswer();
		});

	clientNode.transport
		.on("error", error => {
			log(error.message);

			clientNode.transport.stop();
		})
		.on("sdp.answer", async sdp => {
			log("answer created");

			await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/answer", {
				method: "POST",
				body: JSON.stringify(sdp)
			});
		});

	const waitForOffer = async () => {
		log("waitForOffer");

		const response = await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/offer", {
			method: "GET"
		});

		if (response.status === 200) {
			const sdpOffer = await response.json();
			clientNode.transport.createAnswer(sdpOffer);
		} else {
			setTimeout(waitForOffer, 1000);
		}
	};

	waitForOffer();

	await Promise.all([
		new Promise(async resolve => {
			serverNode.start();
			clientNode.start();

			clientNode.transport.start();
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
