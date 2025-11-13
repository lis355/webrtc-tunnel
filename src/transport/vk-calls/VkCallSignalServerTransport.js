import net from "node:net";

import { getVkWebSocketSignalServerUrlByJoinId, VkWebSocketSignalServer } from "./VkWebSocketSignalServer.js";
import ntun from "../../ntun.js";
import { log } from "../../utils/log.js";
import symmetricStringCipher from "../../utils/symmetricStringCipher.js";

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
	static STATES = {
		CONNECTING: 0,
		CONNECTED: 1
	};

	static MESSAGE_TYPES = {
		CONNECT: 0,
		ACCEPT: 1,
		BUFFER: 2
	};

	constructor(joinId) {
		super();

		this.joinId = joinId;

		this.handleOnConnected = this.handleOnConnected.bind(this);
		this.handleOnDisconnected = this.handleOnDisconnected.bind(this);
		this.handleVkWebSocketSignalServerOnError = this.handleVkWebSocketSignalServerOnError.bind(this);
		this.handleVkWebSocketSignalServerOnStarted = this.handleVkWebSocketSignalServerOnStarted.bind(this);
		this.handleVkWebSocketSignalServerOnStopped = this.handleVkWebSocketSignalServerOnStopped.bind(this);
		this.handleVkWebSocketSignalServerOnReady = this.handleVkWebSocketSignalServerOnReady.bind(this);
		this.handleVkWebSocketSignalServerOnMessage = this.handleVkWebSocketSignalServerOnMessage.bind(this);
		this.handleVkWebSocketSignalServerOnNotification = this.handleVkWebSocketSignalServerOnNotification.bind(this);
		this.handleSocketOnWrite = this.handleSocketOnWrite.bind(this);

		this.on("connected", this.handleOnConnected);
		this.on("disconnected", this.handleOnDisconnected);
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

		if (this.socket) {
			this.socket.destroy();
			this.socket = null;
		}

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

		this.state = VkCallSignalServerTransport.STATES.CONNECTING;

		// Поиск и синхронизация пары участников (подразумевается что только 2 участника будут использовать этот чат звонка)
		// Алгоритм Детерминированный выбор на основе ID
		// Участники сравнивают свои ID (например, лексикографически)
		// Участник с "меньшим" ID всегда инициирует
		// Участник с "большим" ID всегда ждет инициативы
		// После получения запроса - сразу подтверждают

		this.participants = {};

		this.vkWebSocketSignalServer.connectionInfo.conversation.participants
			.filter(participant => participant.id !== this.vkWebSocketSignalServer.participantId)
			.forEach(participant => { this.participants[participant.id] = participant; });

		this.sendConnectToOpponentParticipants();
	}

	sendConnectToOpponentParticipants() {
		Object.values(this.participants)
			.filter(participant => participant.id > this.vkWebSocketSignalServer.participantId)
			.forEach(participant => {
				this.sendMessageToParticipant(participant.id, VkCallSignalServerTransport.MESSAGE_TYPES.CONNECT);
			});
	}

	handleVkWebSocketSignalServerOnMessage(message) {
		// if (message &&
		// 	message.type === "notification" &&
		// 	["connection", "settings-update"].includes(message.notification)) return;

		// log("handleVkWebSocketSignalServerOnMessage", message);
	}

	handleVkWebSocketSignalServerOnNotification(message) {
		switch (message.notification) {
			case "custom-data": {
				const senderParticipantId = message.participantId;
				const decryptedMessage = symmetricStringCipher.decrypt(message.data);
				if (decryptedMessage) {
					const { type, ...data } = JSON.parse(decryptedMessage);

					this.handleOnParticipantMessage(senderParticipantId, type, data);
				} else {
					log("Transport", this.constructor.name, "unknown custom-data message from participant", senderParticipantId, "data", str);
				}

				break;
			}

			case "registered-peer": {
				if (message.participantType === "USER" &&
					message.platform === "WEB" &&
					message.clientType === "VK") {
					const participantId = message.participantId;

					this.participants[participantId] = { id: participantId };

					if (this.state === VkCallSignalServerTransport.STATES.CONNECTING &&
						participantId > this.vkWebSocketSignalServer.participantId) {
						this.sendMessageToParticipant(participantId, VkCallSignalServerTransport.MESSAGE_TYPES.CONNECT);
					}

					break;
				}
			}

			case "hungup": {
				const participantId = message.participantId;

				delete this.participants[participantId];

				if (this.state = VkCallSignalServerTransport.STATES.CONNECTED &&
					participantId === this.opponentParticipantId) {
					this.state = VkCallSignalServerTransport.STATES.CONNECTING;

					this.opponentParticipantId = null;

					this.socket = null;

					this.sendConnectToOpponentParticipants();
				}

				break;
			}
		}
	}

	handleOnParticipantMessage(participantId, type, data) {
		switch (this.state) {
			case VkCallSignalServerTransport.STATES.CONNECTING: {
				switch (type) {
					case VkCallSignalServerTransport.MESSAGE_TYPES.CONNECT: {
						if (participantId < this.vkWebSocketSignalServer.participantId &&
							!this.opponentParticipantId) {
							this.state = VkCallSignalServerTransport.STATES.CONNECTED;

							this.opponentParticipantId = participantId;

							this.sendMessageToParticipant(this.opponentParticipantId, VkCallSignalServerTransport.MESSAGE_TYPES.ACCEPT);

							this.socket = new TransportBufferSocketWrapper();
						} else log("Transport", this.constructor.name, "bad logic message from participant", participantId, type, data);

						break;
					}
					case VkCallSignalServerTransport.MESSAGE_TYPES.ACCEPT: {
						if (participantId > this.vkWebSocketSignalServer.participantId &&
							!this.opponentParticipantId) {
							this.state = VkCallSignalServerTransport.STATES.CONNECTED;

							this.opponentParticipantId = participantId;

							this.socket = new TransportBufferSocketWrapper();
						} else log("Transport", this.constructor.name, "bad logic message from participant", participantId, type, data);

						break;
					}
					default: log("Transport", this.constructor.name, "bad logic message from participant", participantId, type, data);
				}

				break;
			}
			case VkCallSignalServerTransport.STATES.CONNECTED: {
				switch (type) {
					case VkCallSignalServerTransport.MESSAGE_TYPES.BUFFER: {
						this.socket.push(Buffer.from(data.buffer, "base64"));

						break;
					}
					default: log("Transport", this.constructor.name, "bad logic message from participant", participantId, type, data);
				}

				break;
			}
		}
	}

	sendMessageToParticipant(participantId, type, data = {}) {
		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId,
			data: symmetricStringCipher.encrypt(JSON.stringify({ type, ...data }))
		});
	}

	handleOnConnected() {
		this.socket
			.on("write", this.handleSocketOnWrite);
	}

	handleOnDisconnected() {
		this.socket
			.off("write", this.handleSocketOnWrite);
	}

	handleSocketOnWrite(buffer) {
		this.sendMessageToParticipant(this.opponentParticipantId, VkCallSignalServerTransport.MESSAGE_TYPES.BUFFER, { buffer: buffer.toString("base64") });
	}
}
