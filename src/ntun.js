import crypto from "node:crypto";
import EventEmitter from "node:events";
import net from "node:net";

import * as ws from "ws";
import msgpack from "msgpack5";
import socks from "socksv5";

import * as bufferSocket from "./bufferSocket.js";
import log from "./utils/log.js";

const DEVELOPMENT_FLAGS = {
	stringHash: false,
	logConnectionMultiplexerMessages: false,
	logPrintHexData: false,
	logPrintPeriodicallyStatus: false
};

function getHexTable(buffer, offset = 0, length = null, bytesPerLine = 32) {
	if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

	const totalLength = length || buffer.length;
	let output = "";

	for (let i = 0; i < totalLength; i += bytesPerLine) {
		const lineOffset = offset + i;
		const hexOffset = lineOffset.toString(16).padStart(8, "0");

		let hexPart = "";
		let asciiPart = "";

		for (let j = 0; j < bytesPerLine; j++) {
			const pos = i + j;
			if (pos < totalLength) {
				const byte = buffer[pos];
				hexPart += byte.toString(16).padStart(2, "0") + " ";
				asciiPart += (byte >= 32 && byte <= 126) ? String.fromCharCode(byte) : ".";
			} else {
				hexPart += "   ";
				asciiPart += " ";
			}
		}

		output += `${hexOffset}  ${hexPart} ${asciiPart}\n`;
	}

	return output.trim();
}

const LOCALHOST = "127.0.0.1";
const ALL_INTERFACES = "0.0.0.0";

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
	static getConnectionIdBySocket(socket) {
		return DEVELOPMENT_FLAGS.stringHash
			? `${socket.localAddress}:${socket.localPort}--${socket.remoteAddress}:${socket.remotePort}`
			: int32md5XorHash(socket.localAddress + socket.localPort + socket.remoteAddress + socket.remotePort);
	}

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

		if (DEVELOPMENT_FLAGS.logPrintPeriodicallyStatus) {
			this.logPrintPeriodicallyStatusInterval = setInterval(() => {
				log("Connection", this.constructor.name, this.connections.size, Array.from(this.connections.values()).map(c => c.socket.readyState).join(","));
			}, 1000);
		}
	}

	async stop() {
		for (const [connectionId, connection] of this.connections) {
			this.sendSocketMultiplexerClose(connectionId, "ABORT");

			this.deleteConnection(connection);

			connection.socket.destroy();
		}

		this.connectionMultiplexer.stop();
		this.connectionMultiplexer = null;

		if (DEVELOPMENT_FLAGS.logPrintPeriodicallyStatus) {
			this.logPrintPeriodicallyStatusInterval = clearInterval(this.logPrintPeriodicallyStatusInterval);
		}
	}

	sendSocketMultiplexerConnect(connectionId, destinationHost, destinationPort) {
		this.connectionMultiplexer.sendMessageConnect(connectionId, destinationHost, destinationPort);
	}

	sendSocketMultiplexerClose(connectionId, errorMessage) {
		this.connectionMultiplexer.sendMessageClose(connectionId, errorMessage);
	}

	sendSocketMultiplexerData(connectionId, data) {
		this.connectionMultiplexer.sendMessageData(connectionId, data);
	}

	handleSocketMultiplexerOnConnect(connectionId, destinationHost, destinationPort) { }

	handleSocketMultiplexerOnClose(connectionId, errorMessage) {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		if (errorMessage) log("Connection", this.constructor.name, "remote connection error", connectionId, errorMessage);

		this.deleteConnection(connection);

		connection.socket.destroy();
	}

	handleSocketMultiplexerOnData(connectionId, data) {
		const connection = this.connections.get(connectionId);
		if (!connection) return;

		if (connection.connected) connection.socket.write(data);
		else connection.messages.push(data);
	}

	createConnection(connectionId, socket) {
		const connection = {
			connectionId,
			connected: false,
			socket,
			messages: [],
			listeners: {}
		};

		this.connections.set(connectionId, connection);

		connection.listeners = {
			error: this.handleConnectionSocketOnError.bind(this, connection),
			connect: this.handleConnectionSocketOnConnect.bind(this, connection),
			ready: this.handleConnectionSocketOnReady.bind(this, connection),
			close: this.handleConnectionSocketOnClose.bind(this, connection, false),
			data: this.handleConnectionSocketOnData.bind(this, connection)
		};

		connection.socket
			.on("error", connection.listeners.error)
			.on("connect", connection.listeners.connect)
			.on("ready", connection.listeners.ready)
			.on("close", connection.listeners.close)
			.on("data", connection.listeners.data);

		return connection;
	}

	deleteConnection(connection) {
		connection.socket.off("error", connection.listeners.error);
		connection.socket.off("connect", connection.listeners.connect);
		connection.socket.off("ready", connection.listeners.ready);
		connection.socket.off("close", connection.listeners.close);
		connection.socket.off("data", connection.listeners.data);

		this.connections.delete(connection.connectionId);
	}

	handleConnectionSocketOnError(connection, error) {
		log("Connection", this.constructor.name, `error [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`, error.code || error.message);

		connection.errorMessage = error.code || error.message;
	}

	handleConnectionSocketOnConnect(connection) {
		log("Connection", this.constructor.name, `connected with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

		connection.connected = true;
	}

	handleConnectionSocketOnReady(connection) {
		log("Connection", this.constructor.name, `ready with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

		while (connection.messages.length > 0) connection.socket.write(connection.messages.shift());
		connection.messages = [];
	}

	handleConnectionSocketOnClose(connection) {
		log("Connection", this.constructor.name, `closed with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

		this.deleteConnection(connection);

		this.sendSocketMultiplexerClose(connection.connectionId, connection.errorMessage);
	}

	handleConnectionSocketOnData(connection, data) {
		this.sendSocketMultiplexerData(connection.connectionId, data);
	}
}

class InputConnection extends Connection {
}

class OutputConnection extends Connection {
}

class ConnectionMultiplexer extends EventEmitter {
	static MESSAGE_TYPES = {
		CONNECT: 0,
		CLOSE: 1,
		DATA: 2
	};

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
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPES.CONNECT, connectionId, destinationHost, destinationPort);
	}

	sendMessageClose(connectionId, errorMessage = null) {
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPES.CLOSE, connectionId, errorMessage);
	}

	sendMessageData(connectionId, data) {
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPES.DATA, connectionId, data);
	}

	sendMessage(type, connectionId, ...args) {
		const message = [type, connectionId, ...args];
		const buffer = objectToBuffer(message);

		if (DEVELOPMENT_FLAGS.logConnectionMultiplexerMessages) {
			switch (type) {
				case ConnectionMultiplexer.MESSAGE_TYPES.CONNECT: log("ConnectionMultiplexer", "send", "CONNECT", args[0], args[1]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.CLOSE: log("ConnectionMultiplexer", "send", "CLOSE", args[0]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.DATA: log("ConnectionMultiplexer", "send", "DATA", args[0].length, DEVELOPMENT_FLAGS.logPrintHexData && ("\n" + getHexTable(args[0]))); break;
			}
		}

		this.transport.socket.sendBuffer(buffer);
	}

	async handleTransportSocketOnBuffer(buffer) {
		const message = bufferToObject(buffer);
		const [type, connectionId, ...args] = message;

		if (DEVELOPMENT_FLAGS.logConnectionMultiplexerMessages) {
			switch (type) {
				case ConnectionMultiplexer.MESSAGE_TYPES.CONNECT: log("ConnectionMultiplexer", "receive", "CONNECT", args[0], args[1]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.CLOSE: log("ConnectionMultiplexer", "receive", "CLOSE", args[0]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.DATA: log("ConnectionMultiplexer", "receive", "DATA", args[0].length, DEVELOPMENT_FLAGS.logPrintHexData && ("\n" + getHexTable(args[0]))); break;
			}
		}

		switch (type) {
			case ConnectionMultiplexer.MESSAGE_TYPES.CONNECT: {
				const [destinationHost, destinationPort] = args;
				this.emit("connect", connectionId, destinationHost, destinationPort);

				break;
			}
			case ConnectionMultiplexer.MESSAGE_TYPES.CLOSE: {
				const [errorMessage] = args;
				this.emit("close", connectionId, errorMessage);

				break;
			}
			case ConnectionMultiplexer.MESSAGE_TYPES.DATA: {
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

		log("Connection", "Socks5InputConnection", `local socks proxy server started on socks5://${LOCALHOST}:${this.options.port}`);
	}

	async stop() {
		await super.stop();

		this.server.close();
		this.server = null;

		log("Connection", "Socks5InputConnection", "local socks proxy server stopped");
	}

	onSocksServerConnection(info, accept, deny) {

		// TODO по хорошему, мы можем сначала попробовать законнектить удаленный сокет с dstAddr, а уже потом, при успешном соединении, вызывать accept(true)
		// для этого нужно принимать событие, что удаленный сокет на транспорте подключился, чтобы не отправлять лишних данных сразу... но нужно ли оно это?...

		const socket = accept(true);

		const connectionId = Connection.getConnectionIdBySocket(socket);
		const connection = this.createConnection(connectionId, socket);
		this.handleConnectionSocketOnConnect(connection);

		log("Connection", "Socks5InputConnection", `[${connection.socket.remoteAddress}:${connection.socket.remotePort}] socks proxies to [${info.dstAddr}:${info.dstPort}]`);

		this.sendSocketMultiplexerConnect(connectionId, info.dstAddr, info.dstPort);
	}

	handleSocketMultiplexerOnConnect(connectionId, destinationHost, destinationPort) {
		throw new Error("This is a InputConnection");
	}
}

class InternetOutputConnection extends OutputConnection {
	async start() {
		await super.start();

		log("Connection", "InternetOutputConnection", "started");
	}

	async stop() {
		await super.stop();

		log("Connection", "InternetOutputConnection", "stopped");
	}

	handleSocketMultiplexerOnConnect(connectionId, destinationHost, destinationPort) {
		log("Connection", "InternetOutputConnection", `output internet connection to [${destinationHost}:${destinationPort}]`);

		const destinationSocket = net.connect(destinationPort, destinationHost);

		this.createConnection(connectionId, destinationSocket);
	}
}

class Transport extends EventEmitter {
	constructor() {
		super();

		this.transportSocket = null;
	}

	start() { }
	stop() { }

	get socket() {
		return this.transportSocket;
	}

	set socket(socket) {
		if (this.transportSocket === socket) return;

		if (!socket) this.emit("closed");

		this.transportSocket = socket;

		if (socket) this.emit("connected");
	}
}

class BufferSocketTransport extends Transport {
	constructor() {
		super();

		this.handleSocketOnError = this.handleSocketOnError.bind(this);
		this.handleSocketOnClose = this.handleSocketOnClose.bind(this);
	}

	enhanceSocket(socket) {
		socket = bufferSocket.enhanceSocket(socket);

		socket
			.on("error", this.handleSocketOnError)
			.on("close", this.handleSocketOnClose);

		return socket;
	}

	destroySocket(socket) {
		socket
			.off("error", this.handleSocketOnError)
			.off("close", this.handleSocketOnClose);

		socket.destroy();
	}

	handleSocketOnError(error) { }
	handleSocketOnClose() { }
}

class BufferSocketServerTransport extends BufferSocketTransport {
	constructor(port) {
		super();

		this.port = port;

		this.handleServerOnConnection = this.handleServerOnConnection.bind(this);
	}

	createServer() { }
	destroyServer() { }

	start() {
		super.start();

		log("Transport", this.constructor.name, "starting");

		this.createServer();

		this.server
			.on("connection", this.handleServerOnConnection);
	}

	stop() {
		super.stop();

		log("Transport", this.constructor.name, "stopping");

		if (this.socket) {
			this.socketDestroyedByStopCalled = true;
			this.destroySocket(this.socket);
			this.socket = null;
		}

		this.server
			.off("connection", this.handleServerOnConnection);

		this.destroyServer();
		this.server = null;
	}

	handleServerOnConnection(socket) {
		if (this.socket) {
			log("Transport", this.constructor.name, "server already has a current transport connected socket");

			// drop other connection
			socket.destroy();
		} else {
			this.socketDestroyedByStopCalled = false;

			this.socket = this.enhanceSocket(socket);

			log("Transport", this.constructor.name, "connected", this.socket.localAddress, this.socket.localPort, "<-->", this.socket.remoteAddress, this.socket.remotePort);
		}
	}

	handleSocketOnError(error) {
		let errorMessage = error.message;
		if (error.code === "ECONNREFUSED") errorMessage = "connection refused";
		else if (error.code === "ECONNRESET") errorMessage = "connection reset";
		else if (error.code === "ETIMEDOUT") errorMessage = "connection timeout";

		log("Transport", this.constructor.name, "error", errorMessage);
	}

	handleSocketOnClose() {
		log("Transport", this.constructor.name, "closed", this.socket.remoteAddress, this.socket.remotePort);

		this.socket = null;
	}
}

class TCPBufferSocketServerTransport extends BufferSocketServerTransport {
	constructor(port) {
		super(port);

		this.handleServerOnListening = this.handleServerOnListening.bind(this);
	}

	createServer() {
		this.server = net.createServer();

		this.server
			.on("listening", this.handleServerOnListening);

		this.server.listen(this.port, ALL_INTERFACES, this.handleServerOnListening);
	}

	handleServerOnListening() {
		log("Transport", this.constructor.name, "listening", `${this.server.address().address}:${this.server.address().port}`);
	}

	destroyServer() {
		this.server
			.off("listening", this.handleServerOnListening);

		this.server.close();
	}
}

const TRANSPORT_CONNECTION_TIMEOUT = 5 * 1000;

class BufferSocketClientTransport extends BufferSocketTransport {
	constructor(host, port) {
		super();

		this.host = host;
		this.port = port;

		this.attemptToConnect = this.attemptToConnect.bind(this);
	}

	createSocket() { }

	start() {
		super.start();

		log("Transport", this.constructor.name, "starting");

		this.connecting = true;
		this.attemptToConnectTimeout = setTimeout(this.attemptToConnect, 0);
	}

	stop() {
		super.stop();

		log("Transport", this.constructor.name, "stopping");

		if (this.connecting) {
			this.attemptToConnectTimeout = clearTimeout(this.attemptToConnectTimeout);
			this.connecting = false;
		}

		if (this.socket) {
			this.socketDestroyedByStopCalled = true;
			this.destroySocket(this.socket);
			this.socket = null;
		}
	}

	attemptToConnect() {
		if (!this.connecting) return;

		log("Transport", this.constructor.name, "attempting to connect");

		const socket = this.enhanceSocket(this.createSocket());
		socket
			.on("connect", () => {
				this.socketDestroyedByStopCalled = false;

				this.socket = socket;

				this.connecting = false;

				log("Transport", this.constructor.name, "connected", this.socket.localAddress, this.socket.localPort, "<-->", this.socket.remoteAddress, this.socket.remotePort);
			});
	}

	handleSocketOnError(error) {
		let errorMessage = error.message;
		if (error.code === "ECONNREFUSED") errorMessage = "connection refused";
		else if (error.code === "ECONNRESET") errorMessage = "connection reset";
		else if (error.code === "ETIMEDOUT") errorMessage = "connection timeout";

		log("Transport", this.constructor.name, "error", errorMessage);
	}

	handleSocketOnClose() {
		if (this.socket) log("Transport", this.constructor.name, "closed", this.socket.remoteAddress, this.socket.remotePort);

		this.socket = null;

		if (this.socketDestroyedByStopCalled) {
			this.socketDestroyedByStopCalled = false;
			return;
		}

		const connectionAttemptTimeout = this.connecting ? TRANSPORT_CONNECTION_TIMEOUT : 0;
		if (this.connecting) log("Transport", this.constructor.name, "waiting connection attempt timeout", connectionAttemptTimeout);
		if (!this.connecting) this.connecting = true;
		this.attemptToConnectTimeout = setTimeout(this.attemptToConnect, connectionAttemptTimeout);
	}
}

class TCPBufferSocketClientTransport extends BufferSocketClientTransport {
	createSocket() {
		return net.connect(this.port, this.host);
	}
}

function enhanceWebSocket(webSocket) {
	webSocket.sendBuffer = buffer => webSocket.send(buffer);
	webSocket.end = () => webSocket.close();
	webSocket.destroy = () => webSocket.terminate();
	webSocket.on("open", () => webSocket.emit("connect"));
	webSocket.on("message", message => webSocket.emit("buffer", message));

	Object.defineProperty(webSocket, "localAddress", { get: () => webSocket._socket.localAddress });
	Object.defineProperty(webSocket, "localPort", { get: () => webSocket._socket.localPort });
	Object.defineProperty(webSocket, "remoteAddress", { get: () => webSocket._socket.remoteAddress });
	Object.defineProperty(webSocket, "remotePort", { get: () => webSocket._socket.remotePort });

	return webSocket;
}

class WebSocketBufferSocketServerTransport extends BufferSocketServerTransport {
	createServer() {
		this.server = new ws.WebSocketServer({ host: ALL_INTERFACES, port: this.port });
	}

	destroyServer() {
		this.server.close();
	}

	enhanceSocket(webSocket) {
		return enhanceWebSocket(webSocket);
	}
}

class WebSocketBufferSocketClientTransport extends BufferSocketClientTransport {
	createSocket() {
		return new ws.WebSocket(`ws://${this.host}:${this.port}`);
	}

	enhanceSocket(webSocket) {
		return enhanceWebSocket(webSocket);
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
		BufferSocketServerTransport,
		BufferSocketClientTransport,

		TCPBufferSocketServerTransport,
		TCPBufferSocketClientTransport,

		WebSocketBufferSocketServerTransport,
		WebSocketBufferSocketClientTransport
	}
};
