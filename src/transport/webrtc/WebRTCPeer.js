import EventEmitter from "events";

import wrtc from "wrtc";

export default class WebRTCPeer extends EventEmitter {
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

		this.peerConnection.ondatachannel = event => {
			this.peerConnection.dataChannel = event.channel;
			this.handleDataChannelCreated();
		};
	}

	initialize() {
	}

	destroy() {
		this.peerConnection.dataChannel.close();
		this.peerConnection.dataChannel = null;

		this.peerConnection.close();
		this.peerConnection = null;

		this.iceCandidates = [];
	}

	async waitForIceGathering() {
		if (this.waitForIceGatheringCheckTimeout) throw new Error("ICE gathering already in progress");

		return new Promise((resolve, reject) => {
			this.waitForIceGatheringTime = performance.now();

			this.emit("log", "iceGathering.started");

			this.waitForIceGatheringCheckTimeout = setTimeout(() => {
				this.waitForIceGatheringCheckTimeout = clearTimeout(this.waitForIceGatheringCheckTimeout);

				if (this.peerConnection.iceGatheringState !== "complete") return reject(new Error("ICE gathering time out"));
			}, this.options.iceGatheringTimeout);

			const handleIceCandidate = candidate => {
				this.iceCandidates.push(candidate);

				const type = candidate.candidate.split(" ")[7];
				const addr = candidate.address + ":" + candidate.port;

				this.emit("log", "iceGathering.candidate", type, addr);
			};

			const handleIceGatheringFinished = () => {
				this.waitForIceGatheringCheckTimeout = clearTimeout(this.waitForIceGatheringCheckTimeout);

				this.waitForIceGatheringTime = performance.now() - this.waitForIceGatheringTime;

				this.peerConnection.onicecandidate = null;

				this.emit("log", "iceGathering.finished", this.waitForIceGatheringTime / 1000);

				return resolve();
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
				this.emit("log", "iceGathering.candidateError", error);
			};
		});
	}

	async createOffer() {
		this.peerConnection.dataChannel = this.peerConnection.createDataChannel("chat");
		this.handleDataChannelCreated();

		const offer = await this.peerConnection.createOffer();

		await this.peerConnection.setLocalDescription(offer);

		await this.waitForIceGathering();

		return this.peerConnection.localDescription;
	}

	async createAnswer(offer) {
		await this.peerConnection.setRemoteDescription(offer);

		const answer = await this.peerConnection.createAnswer();

		await this.peerConnection.setLocalDescription(answer);

		await this.waitForIceGathering();

		return this.peerConnection.localDescription;
	}

	async setAnswer(answer) {
		await this.peerConnection.setRemoteDescription(answer);
	}

	handleDataChannelCreated() {
		this.peerConnection.dataChannel.onopen = () => {
			this.emit("connected");
		};

		this.peerConnection.dataChannel.onclose = () => {
			this.emit("disconnected");
		};

		this.peerConnection.dataChannel.onmessage = event => {
			this.handleMessage(event.data);
		};
	}

	sendMessage(message) {
		this.emit("log", "sendMessage", message);

		this.peerConnection.dataChannel.send(message);
	}

	handleMessage(message) {
		this.emit("log", "handleMessage", message);

		this.emit("message", message);
	}
}
