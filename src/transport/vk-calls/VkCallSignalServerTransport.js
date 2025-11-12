import net from "node:net";

import { getVkWebSocketSignalServerUrlByJoinId, VkWebSocketSignalServer } from "./VkWebSocketSignalServer.js";
import ntun from "../../ntun.js";
import log from "../../utils/log.js";
import symmetricStringChipher from "../../utils/symmetricStringChipher.js";

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

// Транспорт, использующий только сигнальный сервер VkWebSocketSignalServer VK
// данные передаются посредством адресного отправления данных методом "custom-data"
export default class VkCallSignalServerTransport extends ntun.Transport {
	static STATE = {
		CONNECTING: 0,
		CONNECTED: 1
	};

	static HANDSHAKE_MESSAGE_CONNECT = "CONNECT";

	constructor(joinId) {
		super();

		this.joinId = joinId;

		this.handleOnConnected = this.handleOnConnected.bind(this);
		this.handleOnClosed = this.handleOnClosed.bind(this);
		this.handleVkWebSocketSignalServerOnError = this.handleVkWebSocketSignalServerOnError.bind(this);
		this.handleVkWebSocketSignalServerOnStarted = this.handleVkWebSocketSignalServerOnStarted.bind(this);
		this.handleVkWebSocketSignalServerOnStopped = this.handleVkWebSocketSignalServerOnStopped.bind(this);
		this.handleVkWebSocketSignalServerOnReady = this.handleVkWebSocketSignalServerOnReady.bind(this);
		this.handleVkWebSocketSignalServerOnMessage = this.handleVkWebSocketSignalServerOnMessage.bind(this);
		this.handleVkWebSocketSignalServerOnNotification = this.handleVkWebSocketSignalServerOnNotification.bind(this);
		this.handleSocketOnWrite = this.handleSocketOnWrite.bind(this);

		this.on("connected", this.handleOnConnected);
		this.on("closed", this.handleOnClosed);
	}

	start() {
		super.start();

		this.startConnection();
	}

	async startConnection() {
		this.webSocketUrl = await getVkWebSocketSignalServerUrlByJoinId(this.joinId);

		this.vkWebSocketSignalServer = new VkWebSocketSignalServer(this.webSocketUrl);
		this.vkWebSocketSignalServer
			.on("error", this.handleVkWebSocketSignalServerOnError)
			.on("started", this.handleVkWebSocketSignalServerOnStarted)
			.on("stopped", this.handleVkWebSocketSignalServerOnStopped)
			.on("ready", this.handleVkWebSocketSignalServerOnReady)
			.on("message", this.handleVkWebSocketSignalServerOnMessage)
			.on("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer.start();
	}

	stop() {
		super.stop();

		this.vkWebSocketSignalServer
			.off("error", this.handleVkWebSocketSignalServerOnError)
			.off("started", this.handleVkWebSocketSignalServerOnStarted)
			.off("stopped", this.handleVkWebSocketSignalServerOnStopped)
			.off("ready", this.handleVkWebSocketSignalServerOnReady)
			.off("message", this.handleVkWebSocketSignalServerOnMessage)
			.off("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer.stop();
		this.vkWebSocketSignalServer = null;

		this.webSocketUrl = null;
	}

	handleVkWebSocketSignalServerOnError(error) {
		log("Transport", this.constructor.name, "VkWebSocketSignalServer error", error.message);
	}

	handleVkWebSocketSignalServerOnStarted() {
		log("Transport", this.constructor.name, "VkWebSocketSignalServer started");
	}

	handleVkWebSocketSignalServerOnStopped() {
		log("Transport", this.constructor.name, "VkWebSocketSignalServer stopped");
	}

	async handleVkWebSocketSignalServerOnReady() {
		log("Transport", this.constructor.name, "VkWebSocketSignalServer", "peerId", this.vkWebSocketSignalServer.peerId, "participantId", this.vkWebSocketSignalServer.participantId, "conversationId", this.vkWebSocketSignalServer.conversationId);

		this.state = VkCallSignalServerTransport.STATE.CONNECTING;

		// кто зашёл вторым, т.е. в this.vkWebSocketSignalServer.connectionInfo.conversation.participants уже есть список участников
		// тот будет оффером, и будет отправлять существущему участнику заявку
		const firstParticipant = this.vkWebSocketSignalServer.connectionInfo.conversation.participants
			.filter(participant => participant.id !== this.vkWebSocketSignalServer.participantId)
			.at(0);

		if (firstParticipant) {
			this.isOfferPeer = true;
			this.isAnswerPeer = false;
			this.myParticipantId = this.vkWebSocketSignalServer.participantId;
			this.opponentParticipantId = firstParticipant.id;

			log("Transport", this.constructor.name, "start offer connection", "opponentParticipantId", this.opponentParticipantId);

			this.startOfferConnection();
		} else {
			this.isOfferPeer = false;
			this.isAnswerPeer = true;
			this.myParticipantId = this.vkWebSocketSignalServer.participantId;
			this.opponentParticipantId = null; // узнаем в notification === "custom-data"

			log("Transport", this.constructor.name, "start answer connection");

			this.startAnswerConnection();
		}
	}

	startOfferConnection() {
		this.sendParticipantMessage(VkCallSignalServerTransport.HANDSHAKE_MESSAGE_CONNECT);
	}

	startAnswerConnection() {
	}

	handleVkWebSocketSignalServerOnMessage(message) {
		// if (message &&
		// 	message.type === "notification" &&
		// 	["connection", "settings-update"].includes(message.notification)) return;

		// log("handleVkWebSocketSignalServerOnMessage", message);
	}

	handleVkWebSocketSignalServerOnNotification(message) {
		if (message.notification === "custom-data") {
			const senderParticipantId = message.participantId;
			const data = message.data;

			const decryptedData = symmetricStringChipher.decrypt(data);
			if (decryptedData) {
				switch (this.state) {
					case VkCallSignalServerTransport.STATE.CONNECTING: {
						let message = decryptedData;

						if (message) this.handleOnParticipantMessage(senderParticipantId, message);
						else log("Transport", this.constructor.name, "unknown custom-data message from participant", senderParticipantId, "data", data);

						break;
					}
					case VkCallSignalServerTransport.STATE.CONNECTED: {
						let buffer;
						try {
							buffer = Buffer.from(decryptedData, "base64");
						} catch {
							log("Transport", this.constructor.name, "bad data decoding from participant", senderParticipantId, "data", data);
						}

						if (buffer) this.handleOnParticipantBuffer(buffer);
						else log("Transport", this.constructor.name, "unknown custom-data message from participant", senderParticipantId, "data", data);

						break;
					}
					default:
						log("Transport", this.constructor.name, "unknown state", this.state);
				}


			} else {
				log("Transport", this.constructor.name, "unknown custom-data message from participant", senderParticipantId, "data", data);
			}
		}
	}

	handleOnParticipantMessage(participantId, message) {
		let connected = false;

		if (this.isOfferPeer) {
			if (message === VkCallSignalServerTransport.HANDSHAKE_MESSAGE_CONNECT &&
				this.opponentParticipantId === participantId) {
				connected = true;
			} else {
				log("Transport", this.constructor.name, "unknown participant message", participantId, message);
			}
		} else if (this.isAnswerPeer) {
			if (message === VkCallSignalServerTransport.HANDSHAKE_MESSAGE_CONNECT) {
				this.opponentParticipantId = participantId;

				this.sendParticipantMessage(VkCallSignalServerTransport.HANDSHAKE_MESSAGE_CONNECT);

				connected = true;
			} else {
				log("Transport", this.constructor.name, "unknown participant message", participantId, message);
			}
		} else {
			log("Transport", this.constructor.name, "unknown logic in participant message", participantId, message);
		}

		if (connected) {
			this.state = VkCallSignalServerTransport.STATE.CONNECTED;

			this.socket = new TransportBufferSocketWrapper();
		}
	}

	handleOnParticipantBuffer(buffer) {
		this.socket.push(buffer);
	}

	sendParticipantMessage(message) {
		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId: this.opponentParticipantId,
			data: symmetricStringChipher.encrypt(message)
		});
	}

	sendParticipantBuffer(buffer) {
		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId: this.opponentParticipantId,
			data: symmetricStringChipher.encrypt(buffer.toString("base64"))
		});
	}

	handleOnConnected() {
		this.socket
			.on("write", this.handleSocketOnWrite);
	}

	handleOnClosed() {
		this.socket
			.off("write", this.handleSocketOnWrite);
	}

	handleSocketOnWrite(buffer) {
		this.sendParticipantBuffer(buffer);
	}
}
