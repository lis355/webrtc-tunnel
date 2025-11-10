import EventEmitter from "node:events";

import wrtc from "wrtc";

import log from "../utils/log.js";
import ntun from "../ntun.js";
import WebRTCPeer from "../../browser/src/common/WebRTCPeer.js";

const DEVELOPMENT_FLAGS = {
	logPeer: true
};

class TransportBufferSocketWrapper extends EventEmitter {
	constructor({ sendBuffer, handleOnBuffer }) {
		super();

		this.sendBuffer = sendBuffer;

		this
			.on("buffer", handleOnBuffer);
	}

	sendBuffer(buffer) {
		this.write(buffer);
	}

	write(data) {
		this.sendBuffer(data);

		return true;
	}
}

class WebRTCPeerTransport extends ntun.Transport {
	constructor(iceServers) {
		super();

		this.iceServers = iceServers;

		this.handlePeerOnConnect = this.handlePeerOnConnect.bind(this);
		this.handlePeerOnDisconnect = this.handlePeerOnDisconnect.bind(this);
		this.handlePeerOnMessage = this.handlePeerOnMessage.bind(this);
	}

	start() {
		super.start();

		log("Transport", this.constructor.name, "starting");

		this.createPeerAndStartConnection();
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

	createPeer() {
		const webRTCPeerOptions = {
			iceServers: this.iceServers,
			cancelGatheringCondition: peer => {
				return peer.iceCandidates.filter(iceCandidate => iceCandidate.type === "relay").length > 0;
			}
		};

		const peer = new WebRTCPeer(wrtc.RTCPeerConnection, webRTCPeerOptions);

		if (DEVELOPMENT_FLAGS.logPeer) {
			peer
				.on("log", (...objs) => {
					const event = objs[0];
					if (event.startsWith("iceGathering")) return;

					if (event === "sendMessage" ||
						event === "handleMessage") {
						objs[1] = WebRTCPeer.arrayBufferToBuffer(objs[1]).toString();
					}

					log(this.constructor.name, "peer log", ...objs);
				});
		}

		return peer;
	}

	async createPeerAndStartConnection() {
		this.peer = this.createPeer();
		this.peer
			.on("connected", this.handlePeerOnConnect)
			.on("disconnected", this.handlePeerOnDisconnect)
			.on("message", this.handlePeerOnMessage);
	}
}

export class WebRTCPeerServerTransport extends WebRTCPeerTransport {
	async createPeerAndStartConnection() {
		await super.createPeerAndStartConnection();

		const sdpOfferBase64 = await this.peer.createOffer();

		await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/offer", {
			method: "POST",
			body: sdpOfferBase64
		});

		log("offer created");

		await new Promise(resolve => {
			const waitForAnswer = async () => {
				log("waitForAnswer");

				const response = await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/answer", {
					method: "GET"
				});

				if (response.status === 200) {
					const sdpAnswerBase64 = await response.text();
					await this.peer.setAnswer(sdpAnswerBase64);

					log("answer settled");

					return resolve();
				} else {
					setTimeout(waitForAnswer, 1000);
				}
			};

			waitForAnswer();
		});
	}

	handlePeerOnConnect() {
		log("Transport", this.constructor.name, "peer connected");

		this.socket = new TransportBufferSocketWrapper({
			sendBuffer: buffer => {
				log("Transport", this.constructor.name, "socket sendBuffer");

				this.peer.sendMessage(WebRTCPeer.bufferToArrayBuffer(buffer));
			},
			handleOnBuffer: buffer => {
				log("Transport", this.constructor.name, "socket handleOnBuffer");

				this.peer.sendMessage(WebRTCPeer.arrayBufferToBuffer(buffer));
			}
		});
	}

	handlePeerOnDisconnect() {
		log("Transport", this.constructor.name, "peer disconnected");

		this.socket = null;
	}

	handlePeerOnMessage(message) {
		log("Transport", this.constructor.name, "message");

		this.socket.sendBuffer(WebRTCPeer.arrayBufferToBuffer(message));
	}
}

export class WebRTCPeerClientTransport extends WebRTCPeerTransport {
	async createPeerAndStartConnection() {
		await super.createPeerAndStartConnection();

		await new Promise(resolve => {
			const waitForOffer = async () => {
				log("waitForOffer");

				const response = await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/offer", {
					method: "GET"
				});

				if (response.status === 200) {
					const sdpOfferBase64 = await response.text();
					const sdpAnswerBase64 = await this.peer.createAnswer(sdpOfferBase64);

					await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/answer", {
						method: "POST",
						body: sdpAnswerBase64
					});

					log("answer created");

					return resolve();
				} else {
					setTimeout(waitForOffer, 1000);
				}
			};

			waitForOffer();
		});
	}

	handlePeerOnConnect() {
		log("Transport", this.constructor.name, "peer connected");

		this.socket = new TransportBufferSocketWrapper({
			sendBuffer: buffer => {
				log("Transport", this.constructor.name, "socket sendBuffer");

				this.peer.sendMessage(WebRTCPeer.bufferToArrayBuffer(buffer));
			},
			handleOnBuffer: buffer => {
				log("Transport", this.constructor.name, "socket handleOnBuffer");

				this.peer.sendMessage(WebRTCPeer.arrayBufferToBuffer(buffer));
			}
		});
	}

	handlePeerOnDisconnect() {
		log("Transport", this.constructor.name, "peer disconnected");

		this.socket = null;
	}

	handlePeerOnMessage(message) {
		log("Transport", this.constructor.name, "message");

		this.socket.sendBuffer(WebRTCPeer.arrayBufferToBuffer(message));
	}
}
