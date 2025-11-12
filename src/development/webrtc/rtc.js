import { config as dotenv } from "dotenv-flow";
import wrtc from "wrtc";

import log from "./utils/log.js";
import WebRTCPeer from "../browser/src/common/WebRTCPeer.js";

dotenv();

const isDevelopment = Boolean(process.env.VSCODE_INJECTION &&
	process.env.VSCODE_INSPECTOR_OPTIONS);

function now() {
	return new Date().toISOString();
}

const simpleSignalServerUrl = process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL;
const iceServers = JSON.parse(process.env.DEVELOP_WEB_RTC_SERVERS);

const webRTCPeerOptions = {
	iceServers,
	cancelGatheringCondition: peer => {
		return peer.iceCandidates.filter(iceCandidate => iceCandidate.type === "relay").length > 0;
	}
};

function createOfferPeer() {
	const offerPeer = new WebRTCPeer(wrtc.RTCPeerConnection, webRTCPeerOptions)
		.on("log", (...objs) => {
			const event = objs[0];
			if (event.startsWith("iceGathering")) return;

			if (event === "sendMessage" ||
				event === "handleMessage") {
				objs[1] = WebRTCPeer.arrayBufferToBuffer(objs[1]).toString();
			}

			log("OFFER LOG", ...objs);
		})
		.on("connected", () => {
			offerPeer.pingInterval = setInterval(() => {

				const messageToSend = "offer ping " + (offerPeer.counter = (offerPeer.counter || 0) + 1).toString() + " " + now();

				offerPeer.sendMessage(WebRTCPeer.bufferToArrayBuffer(Buffer.from(messageToSend)));
			}, 1000);
		})
		.on("disconnected", () => {
			offerPeer.pingInterval = clearInterval(offerPeer.pingInterval);
		})
		.on("message", message => {
			// log("offer handle message: ", WebRTCPeer.arrayBufferToBuffer(message).toString());
		});

	return offerPeer;
}

function createAnswerPeer() {
	const answerPeer = new WebRTCPeer(wrtc.RTCPeerConnection, webRTCPeerOptions)
		.on("log", (...objs) => {
			const event = objs[0];
			if (event.startsWith("iceGathering")) return;

			if (event === "sendMessage" ||
				event === "handleMessage") {
				objs[1] = WebRTCPeer.arrayBufferToBuffer(objs[1]).toString();
			}

			log("ANSWER LOG", ...objs);
		})
		.on("connected", () => {
		})
		.on("disconnected", () => {
		})
		.on("message", message => {
			// log("answer handle message: ", WebRTCPeer.arrayBufferToBuffer(message).toString());

			const messageToSend = "answer pong " + (answerPeer.counter = (answerPeer.counter || 0) + 1).toString() + " " + now();

			answerPeer.sendMessage(WebRTCPeer.bufferToArrayBuffer(Buffer.from(messageToSend)));
		});

	return answerPeer;
}

async function main() {
	if (process.argv[2] === "offer") {
		log("mode offer");

		const offerPeer = createOfferPeer();

		const sdpOfferBase64 = await offerPeer.createOffer();

		await fetch(simpleSignalServerUrl + "/offer", {
			method: "POST",
			body: sdpOfferBase64
		});

		log("offer created");

		const waitForAnswer = async () => {
			const response = await fetch(simpleSignalServerUrl + "/answer", {
				method: "GET"
			});

			if (response.status === 200) {
				const sdpAnswerBase64 = await response.text();
				await offerPeer.setAnswer(sdpAnswerBase64);

				log("answer settled");
			} else {
				setTimeout(waitForAnswer, 1000);
			}
		};

		waitForAnswer();
	} else if (process.argv[2] === "answer") {
		log("mode answer");

		const answerPeer = createAnswerPeer();

		const waitForOffer = async () => {
			const response = await fetch(simpleSignalServerUrl + "/offer", {
				method: "GET"
			});

			if (response.status === 200) {
				const sdpOfferBase64 = await response.text();
				const sdpAnswerBase64 = await answerPeer.createAnswer(sdpOfferBase64);

				await fetch(simpleSignalServerUrl + "/answer", {
					method: "POST",
					body: sdpAnswerBase64
				});

				log("answer created");
			} else {
				setTimeout(waitForOffer, 1000);
			}
		};

		waitForOffer();
	} else {
		// log("mode simple test without signal server");

		// const offerPeer = createOfferPeer();
		// const answerPeer = createAnswerPeer();

		// const sdpOfferBase64 = await offerPeer.createOffer();
		// const sdpAnswerBase64 = await answerPeer.createAnswer(sdpOfferBase64);
		// await offerPeer.setAnswer(sdpAnswerBase64);

		log("mode simple test via signal server");

		const offerPeer = createOfferPeer();
		const answerPeer = createAnswerPeer();

		const sdpOffer = await offerPeer.createOffer();

		await fetch(simpleSignalServerUrl + "/offer", {
			method: "POST",
			body: sdpOffer
		});

		let response = await fetch(simpleSignalServerUrl + "/offer", {
			method: "GET"
		});

		let sdp = await response.text();
		await fetch(simpleSignalServerUrl + "/answer", {
			method: "POST",
			body: await answerPeer.createAnswer(sdp)
		});

		response = await fetch(simpleSignalServerUrl + "/answer", {
			method: "GET"
		});

		sdp = await response.text();
		await offerPeer.setAnswer(sdp);
	}
}

main();
