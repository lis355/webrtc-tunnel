import crypto from "node:crypto";
import EventEmitter from "node:events";
import net from "node:net";

import * as ws from "ws";
import async from "async";
import msgpack from "msgpack5";
import socks from "socksv5";

import * as bufferSocket from "./bufferSocket.js";

const LOCALHOST = "127.0.0.1";

const packer = msgpack();

function objectToBuffer(obj) {
	return packer.encode(obj);
}

function bufferToObject(buffer) {
	return packer.decode(buffer);
}

function int32md5XorHash(str) {
	const hash = crypto.createHash("md5").update(str).digest();

	let result = 0;
	for (let i = 0; i < 16; i += 4) result ^= hash.readInt32BE(i);

	return result;
}

class Connection {
	constructor(node, options = {}) {
		this.node = node;
		this.options = options;
		this.connections = new Map();
	}

	async start() {
		this.connectionMultiplexer = new ConnectionMultiplexer(this.node.transport);

		this.connectionMultiplexer
			.on("connect", this.handleSocketMultiplexerOnConnect.bind(this))
			.on("close", this.handleSocketMultiplexerOnClose.bind(this))
			.on("data", this.handleSocketMultiplexerOnData.bind(this));

		this.connectionMultiplexer.start();
	}

	async stop() {
		for (const [connectionId, connection] of this.connections) {
			this.sendSocketMultiplexerClose(connectionId);

			connection.destroy();
		}

		this.connections.clear();

		this.connectionMultiplexer.stop();
		this.connectionMultiplexer = null;
	}

	sendSocketMultiplexerConnect(connectionId, destinationHost, destinationPort) {
		this.connectionMultiplexer.sendMessageConnect(connectionId, destinationHost, destinationPort);
	}

	sendSocketMultiplexerClose(connectionId) {
		this.connectionMultiplexer.sendMessageClose(connectionId);
	}

	sendSocketMultiplexerData(connectionId, data) {
		this.connectionMultiplexer.sendMessageData(connectionId, data);
	}

	handleSocketMultiplexerOnConnect(connectionId, destinationHost, destinationPort) { }
	handleSocketMultiplexerOnClose(connectionId) { }
	handleSocketMultiplexerOnData(connectionId, data) { }
}

class InputConnection extends Connection {
}

class OutputConnection extends Connection {
}

class ConnectionMultiplexer extends EventEmitter {
	static MESSAGE_TYPE_CONNECT = 0;
	static MESSAGE_TYPE_CLOSE = 1;
	static MESSAGE_TYPE_DATA = 2;

	constructor(transport) {
		super();

		this.transport = transport;

		this.handleTransportSocketOnBuffer = this.handleTransportSocketOnBuffer.bind(this);
	}

	start() {
		this.transport.socket.on("buffer", this.handleTransportSocketOnBuffer);
	}

	stop() {
		this.transport.socket.off("buffer", this.handleTransportSocketOnBuffer);
	}

	sendMessageConnect(connectionId, destinationHost, destinationPort) {
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPE_CONNECT, connectionId, destinationHost, destinationPort);
	}

	sendMessageClose(connectionId) {
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPE_CLOSE, connectionId);
	}

	sendMessageData(connectionId, data) {
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPE_DATA, connectionId, data);
	}

	sendMessage(type, connectionId, ...args) {
		// console.log("ConnectionMultiplexer", "send", "from", this.transport.localPort, "to", this.transport.remotePort, type, connectionId);

		const message = [type, connectionId, ...args];
		const buffer = objectToBuffer(message);

		this.transport.socket.sendBuffer(buffer);
	}

	async handleTransportSocketOnBuffer(buffer) {
		const message = bufferToObject(buffer);
		const [type, connectionId, ...args] = message;

		// console.log("ConnectionMultiplexer", "receive", "to", this.transport.localPort, "from", this.transport.remotePort, type, connectionId);

		switch (type) {
			case ConnectionMultiplexer.MESSAGE_TYPE_CONNECT: {
				const [destinationHost, destinationPort] = args;
				this.emit("connect", connectionId, destinationHost, destinationPort);

				break;
			}
			case ConnectionMultiplexer.MESSAGE_TYPE_CLOSE: {
				this.emit("close", connectionId);

				break;
			}
			case ConnectionMultiplexer.MESSAGE_TYPE_DATA: {
				const [data] = args;
				this.emit("data", connectionId, data);

				break;
			}
		}
	}
}

class Node {
	constructor() {
		this.inputConnection = null;
		this.outputConnection = null;
		this.transport = null;
	}

	async start() {
		if (this.inputConnection) await this.inputConnection.start();
		if (this.outputConnection) await this.outputConnection.start();
	}

	async stop() {
		if (this.inputConnection) await this.inputConnection.stop();
		if (this.outputConnection) await this.outputConnection.stop();
	}
}

class Socks5InputConnection extends InputConnection {
	async start() {
		await super.start();

		this.server = socks.createServer(this.onSocksServerConnection.bind(this));
		this.server.useAuth(socks.auth.None());

		await new Promise(resolve => this.server.listen(this.options.port, LOCALHOST, resolve));

		console.log("Connection", "Socks5InputConnection", "local socks proxy server started on", this.options.port, "port");
	}

	async stop() {
		await super.stop();

		this.server.close();
		this.server = null;

		console.log("Connection", "Socks5InputConnection", "local socks proxy server stopped");
	}

	onSocksServerConnection(info, accept, deny) {
		console.log("Connection", "Socks5InputConnection", `input socket ${info.srcAddr}:${info.srcPort} want connect to [${info.dstAddr}:${info.dstPort}]`);

		const socket = accept(true);
		// const connectionId = `${socket.localAddress}:${socket.localPort} <--> ${socket.remoteAddress}:${socket.remotePort}`;
		const connectionId = int32md5XorHash(socket.localAddress + socket.localPort + socket.remoteAddress + socket.remotePort);
		this.connections.set(connectionId, socket);

		this.sendSocketMultiplexerConnect(connectionId, info.dstAddr, info.dstPort);

		socket
			.on("data", data => {
				this.sendSocketMultiplexerData(connectionId, data);
			})
			.on("close", () => {
				this.connections.delete(connectionId);

				this.sendSocketMultiplexerClose(connectionId);
			});
	}

	handleSocketMultiplexerOnClose(connectionId) {
		const socket = this.connections.get(connectionId);

		socket.removeAllListeners("data");
		socket.removeAllListeners("close");

		socket.destroy();

		this.connections.delete(connectionId);
	}

	handleSocketMultiplexerOnData(connectionId, data) {
		const socket = this.connections.get(connectionId);
		socket.write(data);
	}
}

class InternetOutputConnection extends OutputConnection {
	async start() {
		await super.start();

		console.log("Connection", "InternetOutputConnection", "started");
	}

	async stop() {
		await super.stop();

		console.log("Connection", "InternetOutputConnection", "stopped");
	}

	handleSocketMultiplexerOnConnect(connectionId, destinationHost, destinationPort) {
		const socket = net.connect(destinationPort, destinationHost);
		this.connections.set(connectionId, socket);

		// we must wait until connect, before send any data to remoteSocket, create asyncQueue for each connection
		socket.asyncQueue = async.queue(async task => task());

		socket.asyncQueue.push(async () => {
			return new Promise((resolve, reject) => {
				socket
					.on("connect", () => {
						console.log("Connection", "InternetOutputConnection", `connected with [${socket.remoteAddress}:${socket.remotePort}]`);

						return resolve();
					});
			});
		});

		socket
			.on("data", data => {
				this.sendSocketMultiplexerData(connectionId, data);
			})
			.on("close", () => {
				this.connections.delete(connectionId);

				this.sendSocketMultiplexerClose(connectionId);
			});
	}

	handleSocketMultiplexerOnClose(connectionId) {
		const socket = this.connections.get(connectionId);
		socket.asyncQueue.push(async () => {
			socket.removeAllListeners("data");
			socket.removeAllListeners("close");

			socket.destroy();

			this.connections.delete(connectionId);
		});
	}

	handleSocketMultiplexerOnData(connectionId, data) {
		const socket = this.connections.get(connectionId);
		socket.asyncQueue.push(async () => {
			socket.write(data);
		});
	}
}

class Transport extends EventEmitter {
	constructor() {
		super();

		// current transport socket
		this.socket = null;
	}

	start() { }
	stop() { }

	emitConnectedEvent() {
		this.emit("connected");
	}

	emitClosedEvent() {
		this.emit("closed");
	}
}

class TCPBufferSocketServerTransport extends Transport {
	constructor(port) {
		super();

		this.port = port;
	}

	start() {
		super.start();

		console.log("Transport", "TCPBufferSocketServerTransport", "starting");

		this.server = net.createServer();

		this.server
			.on("connection", socket => {
				if (this.socket) {
					console.error("Transport", "TCPBufferSocketServerTransport", "server already has a current transport connected socket");

					// drop other connection
					socket.destroy();
				} else {
					this.socket = bufferSocket.enhanceSocket(socket);

					console.log("Transport", "TCPBufferSocketServerTransport", "connected", this.socket.localAddress, this.socket.localPort, "<-->", this.socket.remoteAddress, this.socket.remotePort);

					socket
						.on("error", error => {
							let errorMessage = error.message;
							if (error.code === "ECONNREFUSED") errorMessage = "Connection refused";
							else if (error.code === "ECONNRESET") errorMessage = "Connection reset";

							console.error("Transport", "TCPBufferSocketServerTransport", errorMessage);
						})
						.on("close", () => {
							console.log("Transport", "TCPBufferSocketServerTransport", "closed", this.socket.remoteAddress, this.socket.remotePort);

							this.socket = null;

							this.emitClosedEvent();
						});

					this.emitConnectedEvent();
				}
			});

		this.server.listen(this.port, LOCALHOST, () => {
			console.log("Transport", "TCPBufferSocketServerTransport", "listening", this.port);
		});
	}

	stop() {
		super.stop();

		console.log("Transport", "TCPBufferSocketServerTransport", "stopping");

		if (this.socket) this.socket.destroy();

		this.server.close();
		this.server = null;
	}
}

class TCPBufferSocketClientTransport extends Transport {
	constructor(host, port) {
		super();

		this.host = host;
		this.port = port;
	}

	start() {
		super.start();

		console.log("Transport", "TCPBufferSocketClientTransport", "starting");

		const socket = bufferSocket.enhanceSocket(net.connect(this.port, this.host));
		socket
			.on("error", error => {
				let errorMessage = error.message;
				if (error.code === "ECONNREFUSED") errorMessage = "Connection refused";

				console.error("Transport", "TCPBufferSocketClientTransport", errorMessage);
			})
			.on("connect", () => {
				this.socket = socket;

				console.log("Transport", "TCPBufferSocketClientTransport", "connected", this.socket.localAddress, this.socket.localPort, "<-->", this.socket.remoteAddress, this.socket.remotePort);

				this.emitConnectedEvent();
			})
			.on("close", () => {
				if (this.socket) console.log("Transport", "TCPBufferSocketClientTransport", "closed", this.socket.remoteAddress, this.socket.remotePort);

				this.socket = null;

				this.emitClosedEvent();
			});
	}

	stop() {
		super.stop();

		console.log("Transport", "TCPBufferSocketClientTransport", "stopping");

		if (this.socket) this.socket.destroy();
	}
}

class WebSocketBufferSocketTransport extends Transport {
	enhanceWebSocket(webSocket) {
		webSocket.sendBuffer = buffer => webSocket.send(buffer);
		webSocket.end = () => webSocket.close();
		webSocket.on("message", message => webSocket.emit("buffer", message));

		webSocket.localAddress = webSocket._socket.localAddress;
		webSocket.localPort = webSocket._socket.localPort;
		webSocket.remoteAddress = webSocket._socket.remoteAddress;
		webSocket.remotePort = webSocket._socket.remotePort;
	}
}

class WebSocketBufferSocketServerTransport extends WebSocketBufferSocketTransport {
	constructor(port) {
		super();

		this.port = port;
	}

	start() {
		super.start();

		this.server = new ws.WebSocketServer({ host: LOCALHOST, port });

		this.server
			.on("connection", webSocket => {
				if (this.socket) {
					console.error("Connection", "WebSocketBufferSocketServerTransport", "server already has a current transport connected socket");

					// drop other connection
					webSocket.destroy();
				} else {
					this.socket = this.enhanceWebSocket(webSocket);

					console.log("Connection", "WebSocketBufferSocketServerTransport", "connected", this.socket.localAddress, this.socket.localPort, "<-->", this.socket.remoteAddress, this.socket.remotePort);

					webSocket
						.on("close", () => {
							console.log("Connection", "WebSocketBufferSocketServerTransport", "closed", this.socket.remoteAddress, this.socket.remotePort);

							this.socket = null;

							this.emitClosedEvent();
						});

					this.emitConnectedEvent();
				}
			});
	}

	stop() {
		super.stop();

		if (this.socket) this.socket.destroy();

		this.server.close();
		this.server = null;
	}
}

class WebSocketBufferSocketClientTransport extends WebSocketBufferSocketTransport {
	constructor(host, port) {
		super();

		this.host = host;
		this.port = port;
	}

	start() {
		super.start();

		const webSocket = new ws.WebSocket(`ws://${host}:${port}`);
		webSocket
			.on("connect", () => {
				this.socket = this.enhanceWebSocket(webSocket);

				console.log("Transport", "WebSocketBufferSocketClientTransport", "connected", this.socket.localAddress, this.socket.localPort, "<-->", this.socket.remoteAddress, this.socket.remotePort);

				this.emitConnectedEvent();
			})
			.on("close", () => {
				console.log("Transport", "WebSocketBufferSocketClientTransport", "closed", this.socket.remoteAddress, this.socket.remotePort);

				this.socket = null;

				this.emitClosedEvent();
			});
	}

	stop() {
		super.stop();

		if (this.socket) this.socket.destroy();
	}
}

export default {
	Connection,
	InputConnection,
	OutputConnection,
	ConnectionMultiplexer,
	Node,
	Transport,

	inputConnections: {
		Socks5InputConnection
	},
	outputConnections: {
		InternetOutputConnection
	},
	transports: {
		TCPBufferSocketServerTransport,
		TCPBufferSocketClientTransport,
		WebSocketBufferSocketServerTransport,
		WebSocketBufferSocketClientTransport
	}
};
