import EventEmitter from "node:events";

import wrtc from "wrtc";

import log from "../utils/log.js";
import ntun from "../ntun.js";
import WebRTCPeer from "../../browser/src/common/WebRTCPeer.js";

const DEVELOPMENT_FLAGS = {
	logPeer: false
};

class TransportBufferSocketWrapper extends EventEmitter {
	constructor({ sendBuffer }) {
		super();

		this.sendBuffer = sendBuffer;
	}

	write(data) {
		this.sendBuffer(data);

		return true;
	}

	emitBuffer(buffer) {
		this.emit("buffer", buffer);
	}

	emitClose() {
		this.emit("close");
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


		if (this.socket) {
			this.socketDestroyedByStopCalled = true;
			this.destroySocket(this.socket);
			this.socket = null;
		}

		this.peer
			.off("connected", this.handlePeerOnConnect)
			.off("disconnected", this.handlePeerOnDisconnect)
			.off("message", this.handlePeerOnMessage);

		this.peer.destroy();
		this.peer = null;
	}

	destroySocket(socket) {
		socket.emitClose();
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
						// objs[1] = WebRTCPeer.arrayBufferToBuffer(objs[1]).toString();
						return;
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

	handlePeerOnConnect() {
		log("Transport", this.constructor.name, "peer connected");

		this.socketDestroyedByStopCalled = false;

		this.socket = new TransportBufferSocketWrapper({
			sendBuffer: buffer => {
				log("Transport", this.constructor.name, "socket sendBuffer");

				this.peer.sendMessage(WebRTCPeer.bufferToArrayBuffer(buffer));
			}
		});
	}

	handlePeerOnDisconnect() {
		log("Transport", this.constructor.name, "peer disconnected");

		this.socket = null;
	}

	handlePeerOnMessage(message) {
		log("Transport", this.constructor.name, "message");

		this.socket.emitBuffer(WebRTCPeer.arrayBufferToBuffer(message));
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
}
