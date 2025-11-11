import net from "node:net";

import wrtc from "wrtc";

import log from "../utils/log.js";
import ntun from "../ntun.js";
import WebRTCPeer from "../../browser/src/common/WebRTCPeer.js";

const DEVELOPMENT_FLAGS = {
	logPeer: false
};

class TransportBufferSocketWrapper extends net.Socket {
	constructor() {
		super();

		this.handleOnData = this.handleOnData.bind(this);

		this
			.on("data", this.handleOnData);
	}

	write(data) {
		this.emit("write", data);

		return true;
	}

	push(data) {
		this.emit("data", data);

		return true;
	}

	sendBuffer(buffer) {
		this.write(buffer);
	}

	handleOnData(data) {
		this.emit("buffer", data);
	}
}

class WebRTCPeerTransport extends ntun.Transport {
	constructor(iceServers) {
		super();

		this.iceServers = iceServers;

		this.handlePeerOnConnect = this.handlePeerOnConnect.bind(this);
		this.handlePeerOnDisconnect = this.handlePeerOnDisconnect.bind(this);
		this.handlePeerOnMessage = this.handlePeerOnMessage.bind(this);

		this.handleSocketOnWrite = this.handleSocketOnWrite.bind(this);
	}

	start() {
		super.start();

		log("Transport", this.constructor.name, "starting");

		this.startConnection();
	}

	stop() {
		super.stop();

		log("Transport", this.constructor.name, "stopping");

		if (this.socket) {
			this.socketDestroyedByStopCalled = true;
			this.destroySocket(this.socket);
			this.socket = null;
		}

		this.destroyPeer();
	}

	destroySocket(socket) {
		socket.destroy();
	}

	createPeer() {
		const webRTCPeerOptions = {
			iceServers: this.iceServers,
			iceTransportPolicy: "relay",
			iceGatheringTimeout: 10 * 1000,
			cancelGatheringCondition: peer => {
				return this.isPeerHasSomeRelayCandidate();
			}
		};

		this.peer = new WebRTCPeer(wrtc.RTCPeerConnection, webRTCPeerOptions);

		if (DEVELOPMENT_FLAGS.logPeer) {
			this.peer
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

		this.peer
			.on("connected", this.handlePeerOnConnect)
			.on("disconnected", this.handlePeerOnDisconnect)
			.on("message", this.handlePeerOnMessage);
	}

	destroyPeer() {
		this.peer
			.off("connected", this.handlePeerOnConnect)
			.off("disconnected", this.handlePeerOnDisconnect)
			.off("message", this.handlePeerOnMessage);

		this.peer.destroy();
		this.peer = null;
	}

	isPeerHasSomeRelayCandidate() {
		return this.peer.iceCandidates.some(iceCandidate => iceCandidate.type === "relay");
	}

	async startConnection() { }

	async checkTurnServerConnection() {
		let success = true;
		let errorMessage;

		try {
			this.sdpOffer = await this.peer.createOffer();
		} catch (error) {
			errorMessage = error.message;

			success = false;
		}

		if (!this.isPeerHasSomeRelayCandidate()) {
			errorMessage = "No TURN servers";

			success = false;
		}

		if (!success) this.emit("error", new Error(`TURN server connection failed: ${errorMessage}`));

		return success;
	}

	handlePeerOnConnect() {
		log("Transport", this.constructor.name, "peer connected");

		this.socketDestroyedByStopCalled = false;

		this.socket = new TransportBufferSocketWrapper();
		this.socket
			.on("write", this.handleSocketOnWrite);
	}

	handlePeerOnDisconnect() {
		log("Transport", this.constructor.name, "peer disconnected");

		this.socket
			.off("write", this.handleSocketOnWrite);

		this.socket = null;
	}

	handlePeerOnMessage(message) {
		log("Transport", this.constructor.name, "message");

		this.socket.push(WebRTCPeer.arrayBufferToBuffer(message));
	}

	handleSocketOnWrite(buffer) {
		log("Transport", this.constructor.name, "socket sendBuffer");

		this.peer.sendMessage(WebRTCPeer.bufferToArrayBuffer(buffer));
	}
}

export class WebRTCPeerServerTransport extends WebRTCPeerTransport {
	async startConnection() {
		await super.startConnection();

		this.createPeer();

		if (!await this.checkTurnServerConnection()) return;

		await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/offer", {
			method: "POST",
			body: JSON.stringify(this.sdpOffer)
		});

		log("offer created");

		await new Promise(resolve => {
			const waitForAnswer = async () => {
				log("waitForAnswer");

				const response = await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/answer", {
					method: "GET"
				});

				if (response.status === 200) {
					const sdpAnswer = await response.json();
					await this.peer.setAnswer(sdpAnswer);

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
	async startConnection() {
		await super.startConnection();

		this.createPeer();

		if (!await this.checkTurnServerConnection()) return;

		// To prevent
		// Failed to set remote offer sdp: Called in wrong state: kHaveLocalOffer
		// use new peer

		this.destroyPeer();
		this.createPeer();

		await new Promise(resolve => {
			const waitForOffer = async () => {
				log("waitForOffer");

				const response = await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/offer", {
					method: "GET"
				});

				if (response.status === 200) {
					const sdpOffer = await response.json();
					const sdpAnswer = await this.peer.createAnswer(sdpOffer);

					await fetch(process.env.DEVELOP_SIMPLE_SIGNAL_SERVER_URL + "/answer", {
						method: "POST",
						body: JSON.stringify(sdpAnswer)
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
