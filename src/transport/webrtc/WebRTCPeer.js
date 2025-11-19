import EventEmitter from "events";

import wrtc from "wrtc";

import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";

const log = createLog("[WebRTCPeer]");

export class WebRTCPeer extends EventEmitter {
	static ICE_GATHERING_TIMEOUT = 60 * 1000;

	static arrayBufferToBuffer(arrayBuffer) {
		return Buffer.from(arrayBuffer);
	}

	static bufferToArrayBuffer(buffer) {
		return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
	}

	// https://en.wikipedia.org/wiki/Session_Description_Protocol
	// RFC 8866

	static sdpMessageToObject(sdpMessage) {
		return sdpMessage.split("\r\n").filter(Boolean).map(line => line.split("="));
	}

	static objectToSdpMessage(obj) {
		return obj.map(([key, value]) => `${key}=${value}\r\n`).join("");
	}

	constructor(options) {
		super();

		this.options = options;

		this.options.iceGatheringTimeout = this.options.iceGatheringTimeout || WebRTCPeer.ICE_GATHERING_TIMEOUT;
		this.options.cancelGatheringCondition = this.options.cancelGatheringCondition || (peer => false);

		this.peerConnection = new wrtc.RTCPeerConnection({
			iceServers: options.iceServers,
			iceTransportPolicy: options.iceTransportPolicy
		});

		this.iceCandidates = [];

		this.peerConnection.onconnectionstatechange = event => {
			switch (this.peerConnection.connectionState) {
				case "connected":
					this.emit("connected");
					break;
				case "closed":
					this.emit("disconnected");
					break;
			}
		};
	}

	destroy() {
		this.iceCandidates = [];

		this.peerConnection.close();
	}

	get connectionState() {
		return this.peerConnection.connectionState;
	}

	async waitForIceGathering() {
		if (this.waitForIceGatheringCheckTimeout) throw new Error("ICE gathering already in progress");

		return new Promise((resolve, reject) => {
			this.waitForIceGatheringTime = performance.now();

			if (ifLog(LOG_LEVELS.DEBUG)) log("iceGathering.started");

			this.waitForIceGatheringCheckTimeout = setTimeout(() => {
				this.waitForIceGatheringCheckTimeout = clearTimeout(this.waitForIceGatheringCheckTimeout);

				if (this.peerConnection.iceGatheringState !== "complete") return reject(new Error("ICE gathering time out"));
			}, this.options.iceGatheringTimeout);

			const handleIceCandidate = candidate => {
				this.iceCandidates.push(candidate);

				const type = candidate.candidate.split(" ")[7];
				const addr = candidate.address + ":" + candidate.port;

				if (ifLog(LOG_LEVELS.DEBUG)) log("iceGathering.candidate", type, addr);
			};

			const handleIceGatheringFinished = () => {
				this.waitForIceGatheringCheckTimeout = clearTimeout(this.waitForIceGatheringCheckTimeout);

				this.waitForIceGatheringTime = performance.now() - this.waitForIceGatheringTime;

				this.peerConnection.onicegatheringstatechange = null;
				this.peerConnection.onicecandidate = null;
				this.peerConnection.onicecandidateerror = null;

				if (ifLog(LOG_LEVELS.DEBUG)) log("iceGathering.finished", this.waitForIceGatheringTime / 1000);

				return resolve();
			};

			this.peerConnection.onicegatheringstatechange = event => {
				if (ifLog(LOG_LEVELS.DEBUG)) log("iceGathering.statechanged", this.peerConnection.iceGatheringState);
			};

			this.peerConnection.onicecandidate = event => {
				if (event.candidate) {
					handleIceCandidate(event.candidate);

					if (this.options.cancelGatheringCondition(this)) handleIceGatheringFinished();
				} else {
					handleIceGatheringFinished();
				}
			};

			this.peerConnection.onicecandidateerror = error => {
				// if (ifLog(LOG_LEVELS.DEBUG)) log("iceGathering.candidateError", error.errorText);
			};
		});
	}

	getOfferOptions() {
		// если не добавлено никаких tracks и datachannels до createOffer
		// то iceGathering не начнется,
		// в таком случае нужно добавлять, как минимум, options.offerToReceiveAudio = true;

		return {
			offerToReceiveAudio: true
		};
	}

	async createOffer() {
		const offer = await this.peerConnection.createOffer(this.getOfferOptions());

		await this.peerConnection.setLocalDescription(offer);

		await this.waitForIceGathering();

		if (ifLog(LOG_LEVELS.DEBUG)) log("offer created");

		this.offer = this.peerConnection.localDescription;

		return this.peerConnection.localDescription;
	}

	async createAnswer(offer) {
		await this.peerConnection.setRemoteDescription(offer);

		const answer = await this.peerConnection.createAnswer();

		await this.peerConnection.setLocalDescription(answer);

		await this.waitForIceGathering();

		if (ifLog(LOG_LEVELS.DEBUG)) log("answer created");

		return this.peerConnection.localDescription;
	}

	async setAnswer(answer) {
		await this.peerConnection.setRemoteDescription(answer);
	}
}

export class WebRTCDataChannelPeer extends WebRTCPeer {
	constructor(options) {
		super(options);

		this.peerConnection.ondatachannel = event => {
			this.dataChannel = event.channel;
			this.handleDataChannelCreated();
		};
	}

	destroy() {
		this.peerConnection.ondatachannel = null;

		this.dataChannel.close();

		super.destroy();
	}

	getOfferOptions() {
		return {};
	}

	async createOffer() {
		this.dataChannel = this.peerConnection.createDataChannel("data");
		this.handleDataChannelCreated();

		return super.createOffer();
	}

	handleDataChannelCreated() {
		this.subscribeOnDataChannel();
	}

	subscribeOnDataChannel() {
		this.dataChannel.onopen = () => {
			this.emit("dataChannelOpened");
		};

		this.dataChannel.onclose = () => {
			this.unsubscribeFromDataChannel();
			this.dataChannel = null;

			this.emit("dataChannelClosed");
		};

		this.dataChannel.onmessage = event => {
			this.handleDataChannelOnMessage(event.data);
		};
	}

	unsubscribeFromDataChannel() {
		this.dataChannel.onopen = null;
		this.dataChannel.onclose = null;
		this.dataChannel.onmessage = null;
	}

	handleDataChannelOnMessage(message) {
		if (ifLog(LOG_LEVELS.DEBUG)) log("handleDataChannelOnMessage", message);

		this.emit("dataChannelMessage", message);
	}

	sendDataChannelMessage(message) {
		if (ifLog(LOG_LEVELS.DEBUG)) log("sendDataChannelMessage", message);

		this.dataChannel.send(message);
	}
}
