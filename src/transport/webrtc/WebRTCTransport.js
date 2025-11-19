import net from "node:net";

import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";
import { WebRTCDataChannelPeer, WebRTCPeer } from "./WebRTCPeer.js";
import ntun from "../../ntun.js";
import symmetricBufferCipher from "../../utils/symmetricBufferCipher.js";

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

class WebRTCTransport extends ntun.Transport {
	constructor() {
		super();

		// must be settled before call start
		this.iceServers = null;

		this.handlePeerOnConnected = this.handlePeerOnConnected.bind(this);
		this.handlePeerOnDisconnected = this.handlePeerOnDisconnected.bind(this);
		this.handlePeerOnDataChannelOpened = this.handlePeerOnDataChannelOpened.bind(this);
		this.handlePeerOnDataChannelClosed = this.handlePeerOnDataChannelClosed.bind(this);
		this.handlePeerOnDataChannelMessage = this.handlePeerOnDataChannelMessage.bind(this);
		this.handleSocketOnWrite = this.handleSocketOnWrite.bind(this);
	}

	start() {
		super.start();

		this.startConnection();
	}

	stop() {
		super.stop();

		if (this.socket) {
			this.socket
				.off("write", this.handleSocketOnWrite);

			this.socket = null;
		}

		this.destroyPeer();
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

		this.peer = new WebRTCDataChannelPeer(webRTCPeerOptions);
		this.peer
			.on("connected", this.handlePeerOnConnected)
			.on("disconnected", this.handlePeerOnDisconnected)
			.on("dataChannelOpened", this.handlePeerOnDataChannelOpened)
			.on("dataChannelClosed", this.handlePeerOnDataChannelClosed)
			.on("dataChannelMessage", this.handlePeerOnDataChannelMessage);
	}

	destroyPeer() {
		this.peer
			.off("connected", this.handlePeerOnConnected)
			// .off("disconnected", this.handlePeerOnDisconnected)
			.off("dataChannelOpened", this.handlePeerOnDataChannelOpened)
			.off("dataChannelClosed", this.handlePeerOnDataChannelClosed)
			.off("dataChannelMessage", this.handlePeerOnDataChannelMessage);

		this.peer.destroy();
	}

	isPeerHasSomeRelayCandidate() {
		return this.peer.iceCandidates.some(iceCandidate => iceCandidate.type === "relay");
	}

	async startConnection() {
		this.createPeer();

		this.emitStarted();

		this.turnServerConnectionSuccess = await this.checkTurnServerConnection();
	}

	async checkTurnServerConnection() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("checking turn server connection");

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

		if (success) {
			if (ifLog(LOG_LEVELS.INFO)) this.log("connecting to turn server success");
		}

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

			this.peer
				.off("disconnected", this.handlePeerOnDisconnected);

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

	handlePeerOnConnected() {
	}

	handlePeerOnDisconnected() {
		this.peer
			.off("disconnected", this.handlePeerOnDisconnected);

		this.peer = null;

		if (this.socket) {
			this.socket
				.off("write", this.handleSocketOnWrite);

			this.socket = null;
		}

		if (this.workingState === ntun.WORKING_STATE.STOPPING) this.emitStopped();
	}

	handlePeerOnDataChannelOpened() {
		this.socket = new TransportBufferSocketWrapper();
		this.socket
			.on("write", this.handleSocketOnWrite);
	}

	handlePeerOnDataChannelClosed() {
		if (this.socket) {
			this.socket
				.off("write", this.handleSocketOnWrite);

			this.socket = null;
		}
	}

	printConnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("data channel peer connected");
	}

	printDisconnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("data channel peer disconnected");
	}

	handlePeerOnDataChannelMessage(message) {
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("message");

		const buffer = WebRTCPeer.arrayBufferToBuffer(message);
		try {
			const decryptedBuffer = symmetricBufferCipher.decrypt(buffer);
			this.socket.push(decryptedBuffer);
		} catch {
			if (ifLog(LOG_LEVELS.ERROR)) this.log("decrypt message error, connection will be aborted");

			this.stop();
		}
	}

	handleSocketOnWrite(buffer) {
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("socket sendBuffer");

		const encryptedBuffer = symmetricBufferCipher.encrypt(buffer);
		const arrayBuffer = WebRTCPeer.bufferToArrayBuffer(encryptedBuffer);
		this.peer.sendDataChannelMessage(arrayBuffer);
	}
}

class WebRTCPeerTransport extends WebRTCTransport {
	constructor(iceServers) {
		super();

		this.iceServers = iceServers;
	}
}

class WebRTCPeerServerTransport extends WebRTCPeerTransport {
	createLog() {
		this.log = createLog("[transport]", "[webrtc-server]");
	}

	async startConnection() {
		await super.startConnection();

		this.startOfferConnection();
	}
}

class WebRTCPeerClientTransport extends WebRTCPeerTransport {
	createLog() {
		this.log = createLog("[transport]", "[webrtc-client]");
	}

	async startConnection() {
		await super.startConnection();

		this.startAnswerConnection();
	}
}

export default {
	WebRTCTransport,
	WebRTCPeerServerTransport,
	WebRTCPeerClientTransport
};
