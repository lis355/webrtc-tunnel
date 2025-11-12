import net from "node:net";

import log from "../../utils/log.js";
import ntun from "../../ntun.js";
import WebRTCPeer from "./WebRTCPeer.js";

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

export class WebRTCTransport extends ntun.Transport {
	constructor() {
		super();

		// must be settled before call start
		this.iceServers = null;

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

		if (this.socket) this.socket = null;

		if (this.peer) this.destroyPeer();
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

		this.peer = new WebRTCPeer(webRTCPeerOptions);

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

	async startConnection() {
		this.createPeer();

		this.turnServerConnectionSuccess = await this.checkTurnServerConnection();
	}

	async checkTurnServerConnection() {
		let success = true;
		let errorMessage;

		try {
			// remember sdpOffer to prevent second creation
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

	startOfferConnection() {
		if (this.turnServerConnectionSuccess) {
			this.createOffer();
		}
	}

	startAnswerConnection() {
		if (this.turnServerConnectionSuccess) {
			// To prevent
			// Failed to set remote offer sdp: Called in wrong state: kHaveLocalOffer
			// use new peer

			this.destroyPeer();
			this.createPeer();
		}
	}

	// connection flow

	// called on server (offer peer)
	// "sdp.offer" event when created sdp offer
	async createOffer() {
		this.emit("sdp.offer", this.sdpOffer);
	}

	// called on client (answer peer)
	// "sdp.answer" event when created sdp answer
	async createAnswer(sdpOffer) {
		this.sdpAnswer = await this.peer.createAnswer(sdpOffer);

		this.emit("sdp.answer", this.sdpAnswer);
	}

	// to server (offer peer)
	async setAnswer(sdpAnswer) {
		this.peer.setAnswer(sdpAnswer);
	}

	handlePeerOnConnect() {
		log("Transport", this.constructor.name, "peer connected");

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

class WebRTCPeerTransport extends WebRTCTransport {
	constructor(iceServers) {
		super();

		this.iceServers = iceServers;
	}
}

export class WebRTCPeerServerTransport extends WebRTCPeerTransport {
	async startConnection() {
		await super.startConnection();

		this.startOfferConnection();
	}
}

export class WebRTCPeerClientTransport extends WebRTCPeerTransport {
	async startConnection() {
		await super.startConnection();

		this.startAnswerConnection();
	}
}
