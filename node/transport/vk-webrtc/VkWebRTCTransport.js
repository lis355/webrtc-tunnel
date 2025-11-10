import wrtc from "wrtc";

import log from "./utils/log.js";
import ntun from "./ntun.js";
import WebRTCPeer from "../browser/src/common/WebRTCPeer.js";
import vk from "./vk.js";

function createOfferPeer(iceServers) {
	const webRTCPeerOptions = {
		iceServers,
		cancelGatheringCondition: peer => {
			return peer.iceCandidates.filter(iceCandidate => iceCandidate.type === "relay").length > 0;
		}
	};

	const offerPeer = new WebRTCPeer(wrtc.RTCPeerConnection, webRTCPeerOptions)
		.on("log", (...objs) => {
			const event = objs[0];
			if (event.startsWith("iceGathering")) return;

			if (event === "sendMessage" ||
				event === "handleMessage") {
				objs[1] = WebRTCPeer.arrayBufferToBuffer(objs[1]).toString();
			}

			log("OFFER LOG", ...objs);
		});


	return offerPeer;
}

class WebRTCPeerServerTransport extends ntun.Transport {
	constructor(vkJoinIdOrLink) {
		super();

		this.joinId = vk.getJoinId(vkJoinIdOrLink);

		this.handlePeerOnConnect = this.handlePeerOnConnect.bind(this);
		this.handlePeerOnDisconnect = this.handlePeerOnDisconnect.bind(this);
		this.handlePeerOnMessage = this.handlePeerOnMessage.bind(this);
	}

	start() {
		super.start();

		log("Transport", this.constructor.name, "starting");

		this.createPeer();
	}

	stop() {
		super.stop();

		log("Transport", this.constructor.name, "stopping");

		if (this.socket) this.destroySocket(this.socket);

		this.peer
			.off("connected", this.handlePeerOnConnect)
			.off("disconnected", this.handlePeerOnDisconnect)
			.off("message", this.handlePeerOnMessage);

		this.peer.destroy();
		this.peer = null;
	}

	async createPeer() {
		vk.getVkWebSocketSignalServerUrlByJoinId(this.joinId);
		this.vkWebSocketSignalServer = new vk.VkWebSocketSignalServer(process.env.DEVELOP_VK_WS_URL);
		vk.VkWebSocketSignalServer;
		// get servers from VkWebSocketSignalServer
		this.iceServers = JSON.parse(process.env.DEVELOP_WEB_RTC_SERVERS);

		this.peer = createOfferPeer(this.iceServers);
		this.peer
			.on("connected", this.handlePeerOnConnect)
			.on("disconnected", this.handlePeerOnDisconnect)
			.on("message", this.handlePeerOnMessage);

		const sdpOfferBase64 = await this.peer.createOffer();

		await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/offer", {
			method: "POST",
			body: sdpOfferBase64
		});

		console.log("offer created");

		// const waitForAnswer = async () => {
		// 	const response = await fetch(SIMPLE_SIGNAL_SERVER_URL + "/answer", {
		// 		method: "GET"
		// 	});

		// 	if (response.status === 200) {
		// 		const sdpAnswerBase64 = await response.text();
		// 		await offerPeer.setAnswer(sdpAnswerBase64);

		// 		console.log("answer settled");
		// 	} else {
		// 		setTimeout(waitForAnswer, 1000);
		// 	}
		// };

		// waitForAnswer();
	}

	handlePeerOnConnect() {
		log("Transport", this.constructor.name, "peer connected");

		// offerPeer.sendMessage(WebRTCPeer.bufferToArrayBuffer(Buffer.from(messageToSend)));

		this.socket = this.enhanceSocket(socket);

		this.socket
			.on("buffer", buffer => {
				this.peer.sendMessage(WebRTCPeer.bufferToArrayBuffer(buffer));
			});
	}

	handlePeerOnDisconnect() {
		log("Transport", this.constructor.name, "peer disconnected");

		this.socket = null;
	}

	handlePeerOnMessage(message) {
		this.socket.sendBuffer(WebRTCPeer.arrayBufferToBuffer(message));
	}
}

class WebRTCPeerClientTransport extends ntun.Transport {
}

export default {
	WebRTCPeerServerTransport,
	WebRTCPeerClientTransport
};

// function createAnswerPeer() {
// 	const answerPeer = new WebRTCPeer(wrtc.RTCPeerConnection, webRTCPeerOptions)
// 		.on("log", (...objs) => {
// 			const event = objs[0];
// 			if (event.startsWith("iceGathering")) return;

// 			if (event === "sendMessage" ||
// 				event === "handleMessage") {
// 				objs[1] = WebRTCPeer.arrayBufferToBuffer(objs[1]).toString();
// 			}

// 			console.log("ANSWER LOG", ...objs);
// 		})
// 		.on("connected", () => {
// 		})
// 		.on("disconnected", () => {
// 		})
// 		.on("message", message => {
// 			// console.log("answer handle message: ", WebRTCPeer.arrayBufferToBuffer(message).toString());

// 			const messageToSend = "answer pong " + (answerPeer.counter = (answerPeer.counter || 0) + 1).toString() + " " + now();

// 			answerPeer.sendMessage(WebRTCPeer.bufferToArrayBuffer(Buffer.from(messageToSend)));
// 		});

// 	return answerPeer;
// }

// // const SIMPLE_SIGNAL_SERVER_PORT_URL = "http://localhost:8260";


// async function main() {
// 	if (process.argv[2] === "offer") {
// 		console.log("mode offer");


// 	} else if (process.argv[2] === "answer") {
// 		console.log("mode answer");

// 		const answerPeer = createAnswerPeer();

// 		const waitForOffer = async () => {
// 			const response = await fetch(SIMPLE_SIGNAL_SERVER_URL + "/offer", {
// 				method: "GET"
// 			});

// 			if (response.status === 200) {
// 				const sdpOfferBase64 = await response.text();
// 				const sdpAnswerBase64 = await answerPeer.createAnswer(sdpOfferBase64);

// 				await fetch(SIMPLE_SIGNAL_SERVER_URL + "/answer", {
// 					method: "POST",
// 					body: sdpAnswerBase64
// 				});

// 				console.log("answer created");
// 			} else {
// 				setTimeout(waitForOffer, 1000);
// 			}
// 		};

// 		waitForOffer();
// 	} else {
// 		// console.log("mode simple test without signal server");

// 		// const offerPeer = createOfferPeer();
// 		// const answerPeer = createAnswerPeer();

// 		// const sdpOfferBase64 = await offerPeer.createOffer();
// 		// const sdpAnswerBase64 = await answerPeer.createAnswer(sdpOfferBase64);
// 		// await offerPeer.setAnswer(sdpAnswerBase64);

// 		console.log("mode simple test via signal server");

// 		const offerPeer = createOfferPeer();
// 		const answerPeer = createAnswerPeer();

// 		const sdpOffer = await offerPeer.createOffer();

// 		await fetch(SIMPLE_SIGNAL_SERVER_URL + "/offer", {
// 			method: "POST",
// 			body: sdpOffer
// 		});

// 		let response = await fetch(SIMPLE_SIGNAL_SERVER_URL + "/offer", {
// 			method: "GET"
// 		});

// 		let sdp = await response.text();
// 		await fetch(SIMPLE_SIGNAL_SERVER_URL + "/answer", {
// 			method: "POST",
// 			body: await answerPeer.createAnswer(sdp)
// 		});

// 		response = await fetch(SIMPLE_SIGNAL_SERVER_URL + "/answer", {
// 			method: "GET"
// 		});

// 		sdp = await response.text();
// 		await offerPeer.setAnswer(sdp);
// 	}
// }

// main();
