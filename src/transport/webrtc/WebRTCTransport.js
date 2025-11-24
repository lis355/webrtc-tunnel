import chalk from "chalk";

import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";
import { WebRTCDataChannelPeer, WebRTCPeer } from "./WebRTCPeer.js";
import ntun from "../../ntun.js";

class WebRTCTransport extends ntun.Transport {
	constructor(options) {
		super(options);

		// must be settled before call start
		this.iceServers = null;

		this.handlePeerOnConnected = this.handlePeerOnConnected.bind(this);
		this.handlePeerOnDisconnected = this.handlePeerOnDisconnected.bind(this);
		this.handlePeerOnDataChannelOpened = this.handlePeerOnDataChannelOpened.bind(this);
		this.handlePeerOnDataChannelClosed = this.handlePeerOnDataChannelClosed.bind(this);
		this.handlePeerOnDataChannelMessage = this.handlePeerOnDataChannelMessage.bind(this);
		this.handleSocketOnError = this.handleSocketOnError.bind(this);
	}

	start() {
		super.start();

		this.startConnection();
	}

	stop() {
		super.stop();

		this.destroyTransportSocket();

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
		if (ifLog(LOG_LEVELS.INFO)) this.log("checking turn server connection", chalk.magenta(this.iceServers.map(iceServer => iceServer.urls).flat().join(", ")));

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
			if (ifLog(LOG_LEVELS.INFO)) this.log("connecting to turn server success", chalk.magenta(this.peer.iceCandidates.filter(iceCandidate => iceCandidate.type === "relay").map(iceCandidate => `${iceCandidate.address}:${iceCandidate.port}`).join(", ")));
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

	createTransportSocket() {
		this.transportSocket = new ntun.transports.TransportSocket({
			write: data => {
				if (ifLog(LOG_LEVELS.DEBUG)) this.log("socket write data");

				const arrayBuffer = WebRTCPeer.bufferToArrayBuffer(data);
				this.peer.sendDataChannelMessage(arrayBuffer);
			},
			...this.options
		});

		this.transportSocket
			.on("error", this.handleSocketOnError);
	}

	destroyTransportSocket() {
		if (this.transportSocket) {
			this.transportSocket
				.off("error", this.handleSocketOnError);

			this.transportSocket.close();

			this.transportSocket = null;
		}
	}

	handlePeerOnConnected() {
	}

	handlePeerOnDisconnected() {
		this.peer
			.off("disconnected", this.handlePeerOnDisconnected);

		this.peer = null;

		this.destroyTransportSocket();

		if (this.workingState === ntun.WORKING_STATE.STOPPING) this.emitStopped();
	}

	handlePeerOnDataChannelOpened() {
		this.createTransportSocket();
	}

	handlePeerOnDataChannelClosed() {
		this.destroyTransportSocket();
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
		this.transportSocket.push(buffer);
	}

	handleSocketOnError(error) {
		if (ifLog(LOG_LEVELS.INFO)) this.log("socket error", error.message);

		this.stop();
	}
}

class WebRTCPeerTransport extends WebRTCTransport {
	constructor(options) {
		super(options);

		this.iceServers = this.options.iceServers;
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
