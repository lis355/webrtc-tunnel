import { createLog, ifLog, LOG_LEVELS } from "../../utils/log.js";
import { getVkWebSocketSignalServerUrlByJoinId, VkWebSocketSignalServer } from "./VkWebSocketSignalServer.js";
import ntun from "../../ntun.js";
import symmetricBufferCipher from "../../utils/symmetricBufferCipher.js";

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

	constructor(options) {
		super(options);

		this.joinId = this.options.joinId;

		this.handleOnConnected = this.handleOnConnected.bind(this);
		this.handleOnDisconnected = this.handleOnDisconnected.bind(this);
		this.handleVkWebSocketSignalServerOnError = this.handleVkWebSocketSignalServerOnError.bind(this);
		this.handleVkWebSocketSignalServerOnStarted = this.handleVkWebSocketSignalServerOnStarted.bind(this);
		this.handleVkWebSocketSignalServerOnStopped = this.handleVkWebSocketSignalServerOnStopped.bind(this);
		this.handleVkWebSocketSignalServerOnReady = this.handleVkWebSocketSignalServerOnReady.bind(this);
		this.handleVkWebSocketSignalServerOnMessage = this.handleVkWebSocketSignalServerOnMessage.bind(this);
		this.handleVkWebSocketSignalServerOnNotification = this.handleVkWebSocketSignalServerOnNotification.bind(this);
		this.handleSocketOnError = this.handleSocketOnError.bind(this);
		this.handleSocketOnClose = this.handleSocketOnClose.bind(this);

		this.on("connected", this.handleOnConnected);
		this.on("disconnected", this.handleOnDisconnected);
	}

	createLog() {
		this.log = createLog("[transport]", "[vk-call]");
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

		this.destroyTransportSocket();

		this.vkWebSocketSignalServer
			.off("error", this.handleVkWebSocketSignalServerOnError)
			.off("started", this.handleVkWebSocketSignalServerOnStarted)
			.off("ready", this.handleVkWebSocketSignalServerOnReady)
			.off("message", this.handleVkWebSocketSignalServerOnMessage)
			.off("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer.stop();

		this.webSocketUrl = null;
	}

	createTransportSocket() {
		this.transportSocket = new ntun.transports.TransportSocket({
			write: data => {
				this.sendMessageToParticipant(this.opponentParticipantId, VkCallSignalServerTransport.MESSAGE_TYPES.BUFFER, { buffer: data.toString("base64") });
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

	handleVkWebSocketSignalServerOnError(error) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server error", error.message);
	}

	handleVkWebSocketSignalServerOnStarted() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server started");

		this.emitStarted();
	}

	handleVkWebSocketSignalServerOnStopped() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("vk signal server stopped");

		this.vkWebSocketSignalServer
			.off("error", this.handleVkWebSocketSignalServerOnError)
			.off("started", this.handleVkWebSocketSignalServerOnStarted)
			.off("stopped", this.handleVkWebSocketSignalServerOnStopped)
			.off("ready", this.handleVkWebSocketSignalServerOnReady)
			.off("message", this.handleVkWebSocketSignalServerOnMessage)
			.off("notification", this.handleVkWebSocketSignalServerOnNotification);

		this.vkWebSocketSignalServer = null;

		this.emitStopped();
	}

	async handleVkWebSocketSignalServerOnReady() {
		// this.log = createLog("[transport]", "[vk-call]", this.vkWebSocketSignalServer.participantId);

		if (ifLog(LOG_LEVELS.INFO)) this.log("vk signal server participantId", this.vkWebSocketSignalServer.participantId, "conversationId", this.vkWebSocketSignalServer.conversationId);

		this.state = VkCallSignalServerTransport.STATES.CONNECTING;

		this.participants = {};

		this.vkWebSocketSignalServer.connectionInfo.conversation.participants
			.filter(participant => participant.id !== this.vkWebSocketSignalServer.participantId)
			.forEach(participant => { this.participants[participant.id] = participant; });

		this.sendConnectToOpponentParticipants();
	}

	sendConnectToOpponentParticipants() {
		Object.values(this.participants)
			.forEach(participant => {
				this.sendMessageToParticipant(participant.id, VkCallSignalServerTransport.MESSAGE_TYPES.CONNECT);
			});
	}

	handleVkWebSocketSignalServerOnMessage(message) {
		// if (message.type === "notification" &&
		// 	["connection", "settings-update", "custom-data"].includes(message.notification) ||
		// 	message.type === "response") return;

		// this.log("handleVkWebSocketSignalServerOnMessage", message);
	}

	handleVkWebSocketSignalServerOnNotification(message) {
		switch (message.notification) {
			case "custom-data": {
				const senderParticipantId = message.participantId;
				try {
					const { type, ...data } = JSON.parse(symmetricBufferCipher.decrypt(Buffer.from(message.data, "base64")).toString());

					this.handleOnParticipantMessage(senderParticipantId, type, data);
				} catch {
					if (ifLog(LOG_LEVELS.INFO)) this.log("unknown custom-data message from participant", senderParticipantId, "data", str);
				}

				break;
			}

			case "registered-peer": {
				if (message.participantType === "USER" &&
					message.platform === "WEB" &&
					message.clientType === "VK") {
					const participantId = message.participantId;

					this.participants[participantId] = { id: participantId };

					if (this.state === VkCallSignalServerTransport.STATES.CONNECTING) {
						this.sendMessageToParticipant(participantId, VkCallSignalServerTransport.MESSAGE_TYPES.CONNECT);
					}

					break;
				}
			}

			case "hungup": {
				const participantId = message.participantId;

				delete this.participants[participantId];

				if (this.state === VkCallSignalServerTransport.STATES.CONNECTED &&
					participantId === this.opponentParticipantId) {
					this.state = VkCallSignalServerTransport.STATES.CONNECTING;

					this.destroyTransportSocket();

					this.sendConnectToOpponentParticipants();
				}

				break;
			}
		}
	}

	handleOnParticipantMessage(participantId, type, data) {
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("handleOnParticipantMessage", participantId, type);

		switch (this.state) {
			case VkCallSignalServerTransport.STATES.CONNECTING: {
				switch (type) {
					case VkCallSignalServerTransport.MESSAGE_TYPES.CONNECT: {
						if (!this.opponentParticipantId) {
							this.state = VkCallSignalServerTransport.STATES.CONNECTED;

							this.opponentParticipantId = participantId;

							this.sendMessageToParticipant(this.opponentParticipantId, VkCallSignalServerTransport.MESSAGE_TYPES.ACCEPT);

							this.createTransportSocket();
						} else {
							if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, type, data);
						}

						break;
					}
					case VkCallSignalServerTransport.MESSAGE_TYPES.ACCEPT: {
						if (!this.opponentParticipantId) {
							this.state = VkCallSignalServerTransport.STATES.CONNECTED;

							this.opponentParticipantId = participantId;

							this.createTransportSocket();
						} else {
							if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, type, data);
						}

						break;
					}
					default: {
						if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, type, data);
					}
				}

				break;
			}
			case VkCallSignalServerTransport.STATES.CONNECTED: {
				switch (type) {
					case VkCallSignalServerTransport.MESSAGE_TYPES.CONNECT: {
						if (ifLog(LOG_LEVELS.INFO)) this.log(participantId, "peer wants to connect, ignore (already connected)");

						break;
					}
					case VkCallSignalServerTransport.MESSAGE_TYPES.ACCEPT: {
						if (participantId !== this.opponentParticipantId) {
							if (ifLog(LOG_LEVELS.INFO)) this.log(participantId, "peer wants to accept, ignore (already connected)");
						}

						break;
					}
					case VkCallSignalServerTransport.MESSAGE_TYPES.BUFFER: {
						this.transportSocket.push(Buffer.from(data.buffer, "base64"));

						break;
					}
					default: {
						if (ifLog(LOG_LEVELS.INFO)) this.log("bad logic message from participant", participantId, type, data);
					}
				}

				break;
			}
		}
	}

	sendMessageToParticipant(participantId, type, data = {}) {
		if (ifLog(LOG_LEVELS.DEBUG)) this.log("sendMessageToParticipant", participantId, type);

		this.vkWebSocketSignalServer.sendCommand("custom-data", {
			participantId,
			data: symmetricBufferCipher.encrypt(Buffer.from(JSON.stringify({ type, ...data }))).toString("base64")
		});
	}

	handleOnConnected() {
	}

	handleOnDisconnected() {
		this.opponentParticipantId = null;
	}

	handleSocketOnError(error) {
		if (ifLog(LOG_LEVELS.INFO)) this.log("socket error", error.message);

		// TODO handle
	}

	handleSocketOnClose() {
		this.destroyTransportSocket();
	}
}
