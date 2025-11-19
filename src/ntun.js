import crypto from "node:crypto";
import EventEmitter from "node:events";
import net from "node:net";

import * as ws from "ws";
import chalk from "chalk";
import msgpack from "msgpack5";
import socks from "socksv5";

import * as bufferSocket from "./bufferSocket.js";
import { createLog, ifLog, LOG_LEVELS } from "./utils/log.js";

const DEVELOPMENT_FLAGS = {
	stringHash: false,
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
	for (let i = 0; i < 16; i += 4) result ^= hash.readInt32BE(i) & 0x7FFFFFFF;

	return result;
}

const WORKING_STATE = {
	IDLE: "idle",
	STARTING: "starting",
	WORKING: "working",
	STOPPING: "stopping"
};

class Connection extends EventEmitter {
	static getConnectionIdBySocket(socket) {
		return DEVELOPMENT_FLAGS.stringHash
			? `${socket.localAddress}:${socket.localPort}--${socket.remoteAddress}:${socket.remotePort}`
			: int32md5XorHash(socket.localAddress + socket.localPort + socket.remoteAddress + socket.remotePort);
	}

	constructor(node, options = {}) {
		super();

		this.createLog();

		this.node = node;
		this.options = options;

		this.connections = new Map();
		this.connectionMultiplexer = new ConnectionMultiplexer(this.node.transport);

		this.workingState = WORKING_STATE.IDLE;

		this.handleOnTransportConnected = this.handleOnTransportConnected.bind(this);
		this.handleOnTransportDisconnected = this.handleOnTransportDisconnected.bind(this);
		this.handleSocketMultiplexerOnConnect = this.handleSocketMultiplexerOnConnect.bind(this);
		this.handleSocketMultiplexerOnClose = this.handleSocketMultiplexerOnClose.bind(this);
		this.handleSocketMultiplexerOnData = this.handleSocketMultiplexerOnData.bind(this);

		if (ifLog(LOG_LEVELS.INFO)) this.log("created for node", chalk.green(this.node.name));
	}

	createLog() { throw new Error("Not implemented"); }

	start() {
		if (this.workingState !== WORKING_STATE.IDLE) throw new Error("Not in idle state");

		this.workingState = WORKING_STATE.STARTING;

		this.emitWillStart();

		this.node.transport
			.on("connected", this.handleOnTransportConnected)
			.on("disconnected", this.handleOnTransportDisconnected);

		if (this.node.transport.isConnected) this.handleOnTransportConnected();
	}

	emitWillStart() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("will start");

		this.emit("willStart");
	}

	emitStarted() {
		if (DEVELOPMENT_FLAGS.logPrintPeriodicallyStatus) {
			this.logPrintPeriodicallyStatusInterval = setInterval(() => {
				this.log("Connection", this.constructor.name, this.connections.size, Array.from(this.connections.values()).map(c => c.socket.readyState).join(","));
			}, 1000);
		}

		this.workingState = WORKING_STATE.WORKING;

		if (ifLog(LOG_LEVELS.DETAILED)) this.log("started");

		this.emit("started");
	}

	stop() {
		if (this.workingState !== WORKING_STATE.WORKING) throw new Error("Not in working state");

		this.workingState = WORKING_STATE.STOPPING;

		this.emitWillStop();

		for (const [connectionId, connection] of this.connections) {
			if (this.node.transport.isConnected) this.sendSocketMultiplexerClose(connectionId, "abort");

			this.deleteConnection(connection);

			connection.socket.destroy();
		}

		this.unsubscribeFromConnectionMultiplexer();

		this.connectionMultiplexer.socket = null;

		this.node.transport
			.off("connected", this.handleOnTransportConnected)
			.off("disconnected", this.handleOnTransportDisconnected);
	}

	emitWillStop() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("will stop");

		this.emit("willStop");
	}

	emitStopped() {
		if (DEVELOPMENT_FLAGS.logPrintPeriodicallyStatus) {
			this.logPrintPeriodicallyStatusInterval = clearInterval(this.logPrintPeriodicallyStatusInterval);
		}

		this.workingState = WORKING_STATE.IDLE;

		if (ifLog(LOG_LEVELS.DETAILED)) this.log("stopped");

		this.emit("stopped");
	}

	handleOnTransportConnected() {
		this.subscribeOnConnectionMultiplexer();

		this.connectionMultiplexer.socket = this.node.transport.socket;
	}

	handleOnTransportDisconnected() {
		this.unsubscribeFromConnectionMultiplexer();

		this.connectionMultiplexer.socket = null;
	}

	subscribeOnConnectionMultiplexer() {
		this.connectionMultiplexer
			.on("connect", this.handleSocketMultiplexerOnConnect)
			.on("close", this.handleSocketMultiplexerOnClose)
			.on("data", this.handleSocketMultiplexerOnData);
	}

	unsubscribeFromConnectionMultiplexer() {
		this.connectionMultiplexer
			.off("connect", this.handleSocketMultiplexerOnConnect)
			.off("close", this.handleSocketMultiplexerOnClose)
			.off("data", this.handleSocketMultiplexerOnData);
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

		if (errorMessage) {
			if (ifLog(LOG_LEVELS.DETAILED)) this.log("remote connection error", connectionId, errorMessage);
		}

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
		connection.socket
			.off("error", connection.listeners.error)
			.off("connect", connection.listeners.connect)
			.off("ready", connection.listeners.ready)
			.off("close", connection.listeners.close)
			.off("data", connection.listeners.data);

		this.connections.delete(connection.connectionId);
	}

	handleConnectionSocketOnError(connection, error) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`error [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`, error.code || error.message);

		connection.errorMessage = error.code || error.message;
	}

	handleConnectionSocketOnConnect(connection) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`connected with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

		connection.connected = true;
	}

	handleConnectionSocketOnReady(connection) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`ready with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

		while (connection.messages.length > 0) connection.socket.write(connection.messages.shift());
	}

	handleConnectionSocketOnClose(connection) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`closed with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

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

const connectionMultiplexerLog = createLog("[multiplexer]");

class ConnectionMultiplexer extends EventEmitter {
	static MESSAGE_TYPES = {
		CONNECT: 0,
		CLOSE: 1,
		DATA: 2
	};

	constructor() {
		super();

		this._socket = null;

		this.handleSocketOnBuffer = this.handleSocketOnBuffer.bind(this);
	}

	get socket() {
		return this._socket;
	}

	set socket(newSocket) {
		if (this._socket === newSocket) return;

		if (this._socket) this._socket.off("buffer", this.handleSocketOnBuffer);

		this._socket = newSocket;

		if (this._socket) this._socket.on("buffer", this.handleSocketOnBuffer);
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

		if (ifLog(LOG_LEVELS.DEBUG)) {
			switch (type) {
				case ConnectionMultiplexer.MESSAGE_TYPES.CONNECT: connectionMultiplexerLog("send", "CONNECT", args[0], args[1]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.CLOSE: connectionMultiplexerLog("send", "CLOSE", args[0]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.DATA: connectionMultiplexerLog("send", "DATA", args[0].length, "\n" + getHexTable(args[0])); break;
			}
		}

		this.socket.sendBuffer(buffer);
	}

	async handleSocketOnBuffer(buffer) {
		const message = bufferToObject(buffer);
		const [type, connectionId, ...args] = message;

		if (ifLog(LOG_LEVELS.DEBUG)) {
			switch (type) {
				case ConnectionMultiplexer.MESSAGE_TYPES.CONNECT: connectionMultiplexerLog("receive", "CONNECT", args[0], args[1]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.CLOSE: connectionMultiplexerLog("receive", "CLOSE", args[0]); break;
				case ConnectionMultiplexer.MESSAGE_TYPES.DATA: connectionMultiplexerLog("receive", "DATA", args[0].length, "\n" + getHexTable(args[0])); break;
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

class Node extends EventEmitter {
	constructor(options = {}) {
		super();

		this.id = crypto.randomUUID();
		this.options = options;
		this.createLog();

		this.connection = null;
		this.transport = null;

		this.workingState = WORKING_STATE.IDLE;

		this.handleConnectionOnStarted = this.handleConnectionOnStarted.bind(this);
		this.handleConnectionOnStopped = this.handleConnectionOnStopped.bind(this);

		if (ifLog(LOG_LEVELS.INFO)) {
			if (this.name !== this.id) this.log("created", chalk.green(this.id));
			else this.log("created");
		}
	}

	createLog() {
		this.log = createLog("[node]", chalk.green(this.name));
	}

	get name() {
		return this.options.name || this.id;
	}

	start() {
		if (this.workingState !== WORKING_STATE.IDLE) throw new Error("Not in idle state");
		if (!this.connection) throw new Error("No connection");
		if (!this.transport) throw new Error("No transport");

		this.workingState = WORKING_STATE.STARTING;

		this.emitWillStart();

		this.connection
			.on("started", this.handleConnectionOnStarted)
			.on("stopped", this.handleConnectionOnStopped);

		this.connection.start();
	}

	emitWillStart() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("will start");

		this.emit("willStart");
	}

	emitStarted() {
		this.workingState = WORKING_STATE.WORKING;

		if (ifLog(LOG_LEVELS.DETAILED)) this.log("started");

		this.emit("started");
	}

	stop() {
		if (this.workingState !== WORKING_STATE.WORKING) throw new Error("Not in working state");

		this.workingState = WORKING_STATE.STOPPING;

		this.emitWillStop();

		this.connection.stop();
	}

	emitWillStop() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("will stop");

		this.emit("willStop");
	}

	emitStopped() {
		this.workingState = WORKING_STATE.IDLE;

		if (ifLog(LOG_LEVELS.DETAILED)) this.log("stopped");

		this.emit("stopped");
	}

	handleConnectionOnStarted() {
		this.emitStarted();
	}

	handleConnectionOnStopped() {
		this.connection
			.off("started", this.handleConnectionOnStarted)
			.off("stopped", this.handleConnectionOnStopped);

		this.emitStopped();
	}
}

class Socks5InputConnection extends InputConnection {
	constructor(node, options) {
		super(node, options);

		this.handleOnSocksServerError = this.handleOnSocksServerError.bind(this);
		this.handleOnSocksServerConnection = this.handleOnSocksServerConnection.bind(this);
		this.handleOnSocksServerClose = this.handleOnSocksServerClose.bind(this);
		this.handleOnSocksServerListening = this.handleOnSocksServerListening.bind(this);
	}

	createLog() {
		this.log = createLog("[in]", "[socks5]");
	}

	start() {
		super.start();

		this.createServer();
	}

	stop() {
		super.stop();

		this.destroyServer();
	}

	createServer() {
		this.server = socks.createServer();
		this.server.useAuth(socks.auth.None());

		this.server
			.on("error", this.handleOnSocksServerError)
			.on("connection", this.handleOnSocksServerConnection)
			.on("close", this.handleOnSocksServerClose)
			.on("listening", this.handleOnSocksServerListening);

		this.server.listen(this.options.port, LOCALHOST);
	}

	destroyServer() {
		this.server.close();
	}

	emitStarted() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("local socks proxy server started on", chalk.magenta(`socks5://${LOCALHOST}:${this.options.port}`));

		super.emitStarted();
	}

	emitStopped() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("local socks proxy server stopped");

		super.emitStopped();
	}

	handleOnSocksServerError(error) {
		if (ifLog(LOG_LEVELS.INFO)) this.log(`local socks proxy server error ${error.message}`);
	}

	handleOnSocksServerConnection(info, accept, deny) {
		if (!this.node.transport.isConnected) {
			if (ifLog(LOG_LEVELS.INFO)) this.log(`connection from [${info.srcAddr}:${info.srcPort}] with proxy to [${info.dstAddr}:${info.dstPort}] denied because transport is not connected`);

			return deny();
		}

		// TODO по хорошему, мы можем сначала попробовать законнектить удаленный сокет с dstAddr, а уже потом, при успешном соединении, вызывать accept(true)
		// для этого нужно принимать событие, что удаленный сокет на транспорте подключился, чтобы не отправлять лишних данных сразу... но нужно ли оно это?...

		const socket = accept(true);

		const connectionId = Connection.getConnectionIdBySocket(socket);
		const connection = this.createConnection(connectionId, socket);
		this.handleConnectionSocketOnConnect(connection);

		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`[${connection.socket.remoteAddress}:${connection.socket.remotePort}] socks proxies to [${info.dstAddr}:${info.dstPort}]`);

		this.sendSocketMultiplexerConnect(connectionId, info.dstAddr, info.dstPort);
	}

	handleOnSocksServerClose() {
		this.server
			.off("connection", this.handleOnSocksServerConnection)
			.off("close", this.handleOnSocksServerClose)
			.off("listening", this.handleOnSocksServerListening);

		this.server = null;

		this.emitStopped();
	}

	handleOnSocksServerListening() {
		this.emitStarted();
	}

	handleSocketMultiplexerOnConnect(connectionId, destinationHost, destinationPort) {
		throw new Error("This is a InputConnection");
	}
}

class DirectOutputConnection extends OutputConnection {
	createLog() {
		this.log = createLog("[out]", "[direct]");
	}

	start() {
		super.start();

		this.emitStarted();
	}

	stop() {
		super.stop();

		this.emitStopped();
	}

	handleSocketMultiplexerOnConnect(connectionId, destinationHost, destinationPort) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`output internet connection to [${destinationHost}:${destinationPort}]`);

		const destinationSocket = net.connect(destinationPort, destinationHost);

		this.createConnection(connectionId, destinationSocket);
	}
}

class Transport extends EventEmitter {
	constructor() {
		super();

		this.createLog();

		this._socket = null;

		this.workingState = WORKING_STATE.IDLE;

		if (ifLog(LOG_LEVELS.INFO)) this.log("created");
	}

	createLog() { throw new Error("Not implemented"); }

	start() {
		if (this.workingState !== WORKING_STATE.IDLE) throw new Error("Not in idle state");

		this.workingState = WORKING_STATE.STARTING;

		this.emitWillStart();
	}

	emitWillStart() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("will start");

		this.emit("willStart");
	}

	emitStarted() {
		this.workingState = WORKING_STATE.WORKING;

		if (ifLog(LOG_LEVELS.DETAILED)) this.log("started");

		this.emit("started");
	}

	stop() {
		if (this.workingState !== WORKING_STATE.WORKING) throw new Error("Not in working state");

		this.workingState = WORKING_STATE.STOPPING;

		this.emitWillStop();
	}

	emitWillStop() {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log("will stop");

		this.emit("willStop");
	}

	emitStopped() {
		this.workingState = WORKING_STATE.IDLE;

		if (ifLog(LOG_LEVELS.DETAILED)) this.log("stopped");

		this.emit("stopped");
	}

	get socket() {
		return this._socket;
	}

	set socket(newSocket) {
		if (this._socket === newSocket) return;

		if (!newSocket) {
			this.printDisconnectedLog();

			this.emit("disconnected");
		}

		this._socket = newSocket;

		if (newSocket) {
			this.printConnectedLog();

			this.emit("connected");
		}
	}

	printConnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("connected");
	}

	printDisconnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("disconnected");
	}

	get isConnected() {
		return Boolean(this.socket);
	}
}

class BufferSocketTransport extends Transport {
	constructor() {
		super();

		this.handleSocketOnError = this.handleSocketOnError.bind(this);
		this.handleSocketOnClose = this.handleSocketOnClose.bind(this);
	}

	enhanceSocket(socket) {
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

		this.handleServerOnError = this.handleServerOnError.bind(this);
		this.handleServerOnClose = this.handleServerOnClose.bind(this);
		this.handleServerOnListening = this.handleServerOnListening.bind(this);
		this.handleServerOnConnection = this.handleServerOnConnection.bind(this);
	}

	createServer() { throw new Error("Not implemented"); }
	destroyServer() { throw new Error("Not implemented"); }

	startServer() {
		this.createServer();
		this.subscribeOnServer();

		this.listenServer(ALL_INTERFACES);
	}

	listenServer(host) { throw new Error("Not implemented"); }

	closeServer() {
		this.server.close();
	}

	start() {
		super.start();

		this.startServer();
	}

	stop() {
		super.stop();

		if (this.socket) {
			this.socketDestroyedByStopCalled = true;
			this.destroySocket(this.socket);
			this.socket = null;
		}

		this.closeServer();
	}

	subscribeOnServer() {
		this.server
			.on("error", this.handleServerOnError)
			.on("close", this.handleServerOnClose)
			.on("listening", this.handleServerOnListening)
			.on("connection", this.handleServerOnConnection);
	}

	unsubscribeFromServer() {
		this.server
			.off("error", this.handleServerOnError)
			.off("close", this.handleServerOnClose)
			.off("listening", this.handleServerOnListening)
			.off("connection", this.handleServerOnConnection);
	}

	handleServerOnError(error) {
		if (ifLog(LOG_LEVELS.INFO)) this.log("error", error.message);
	}

	handleServerOnClose() {
		this.unsubscribeFromServer();
		this.server = null;

		this.emitStopped();
	}

	handleServerOnListening() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("listening", chalk.magenta(`${this.server.address().address}:${this.server.address().port}`));

		this.emitStarted();
	}

	handleServerOnConnection(socket) {
		if (this.socket) {
			// drop other connection

			if (ifLog(LOG_LEVELS.INFO)) this.log("server already has a current transport connected socket, drop other connection", chalk.magenta(`${socket.remoteAddress}:${socket.remotePort}`));

			socket.destroy();
		} else {
			this.socketDestroyedByStopCalled = false;

			this.socket = this.enhanceSocket(socket);
		}
	}

	handleSocketOnError(error) {
		let errorMessage = error.message;
		if (error.code === "ECONNREFUSED") errorMessage = "connection refused";
		else if (error.code === "ECONNRESET") errorMessage = "connection reset";
		else if (error.code === "ETIMEDOUT") errorMessage = "connection timeout";

		if (ifLog(LOG_LEVELS.INFO)) this.log("error", errorMessage);
	}

	handleSocketOnClose() {
		this.socket = null;
	}

	printConnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("connected", chalk.magenta(`${this.socket.localAddress}:${this.socket.localPort}`), "--", chalk.magenta(`${this.socket.remoteAddress}:${this.socket.remotePort}`));
	}

	printDisconnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("disconnected", chalk.magenta(`${this.socket.remoteAddress}:${this.socket.remotePort}`));
	}
}

function enhanceTCPSocket(socket) {
	socket = bufferSocket.enhanceSocket(socket);

	return socket;
}

class TCPBufferSocketServerTransport extends BufferSocketServerTransport {
	createLog() {
		this.log = createLog("[transport]", "[tcp-server]");
	}

	createServer() {
		this.server = net.createServer();
	}

	listenServer(host) {
		this.server.listen(this.port, host);
	}

	enhanceSocket(socket) {
		return super.enhanceSocket(enhanceTCPSocket(socket));
	}
}

const TRANSPORT_CONNECTION_TIMEOUT = 3 * 1000;

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

		this.connecting = true;
		this.attemptToConnectTimeout = setTimeout(this.attemptToConnect, 0);

		this.emitStarted();
	}

	stop() {
		super.stop();

		if (this.connecting) {
			this.attemptToConnectTimeout = clearTimeout(this.attemptToConnectTimeout);
			this.connecting = false;
		}

		if (this.socket) {
			this.socketDestroyedByStopCalled = true;
			this.destroySocket(this.socket);
			this.socket = null;
		}

		this.emitStopped();
	}

	attemptToConnect() {
		if (!this.connecting) return;

		if (ifLog(LOG_LEVELS.INFO)) this.log("attempting to connect to", chalk.magenta(`${this.host}:${this.port}`));

		const socket = this.enhanceSocket(this.createSocket());
		socket
			.on("connect", () => {
				this.socketDestroyedByStopCalled = false;

				this.socket = socket;

				this.connecting = false;
			});
	}

	handleSocketOnError(error) {
		let errorMessage = error.message;
		if (error.code === "ECONNREFUSED") errorMessage = "connection refused";
		else if (error.code === "ECONNRESET") errorMessage = "connection reset";
		else if (error.code === "ETIMEDOUT") errorMessage = "connection timeout";

		if (ifLog(LOG_LEVELS.INFO)) this.log("error", errorMessage);
	}

	handleSocketOnClose() {
		this.socket = null;

		if (this.socketDestroyedByStopCalled) {
			this.socketDestroyedByStopCalled = false;
			return;
		}

		const connectionAttemptTimeout = this.connecting ? TRANSPORT_CONNECTION_TIMEOUT : 0;

		if (this.connecting) {
			if (ifLog(LOG_LEVELS.INFO)) this.log("waiting connection attempt timeout", connectionAttemptTimeout);
		}

		if (!this.connecting) this.connecting = true;
		this.attemptToConnectTimeout = setTimeout(this.attemptToConnect, connectionAttemptTimeout);
	}

	printConnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("connected", chalk.magenta(`${this.socket.localAddress}:${this.socket.localPort}`), "--", chalk.magenta(`${this.socket.remoteAddress}:${this.socket.remotePort}`));
	}

	printDisconnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("disconnected from", chalk.magenta(`${this.socket.remoteAddress}:${this.socket.remotePort}`));
	}
}

class TCPBufferSocketClientTransport extends BufferSocketClientTransport {
	createLog() {
		this.log = createLog("[transport]", "[tcp-socket]");
	}

	createSocket() {
		return net.connect(this.port, this.host);
	}

	enhanceSocket(socket) {
		return super.enhanceSocket(enhanceTCPSocket(socket));
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
	createLog() {
		this.log = createLog("[transport]", "[ws-server]");
	}

	createServer() {
		this.server = new ws.WebSocketServer({ host: ALL_INTERFACES, port: this.port });
	}

	listenServer(host) {
		// listen called in WebSocketServer constructor
	}

	enhanceSocket(socket) {
		return super.enhanceSocket(enhanceWebSocket(socket));
	}
}

class WebSocketBufferSocketClientTransport extends BufferSocketClientTransport {
	createLog() {
		this.log = createLog("[transport]", "[ws-socket]");
	}

	createSocket() {
		return new ws.WebSocket(`ws://${this.host}:${this.port}`);
	}

	enhanceSocket(socket) {
		return super.enhanceSocket(enhanceWebSocket(socket));
	}
}

export default {
	WORKING_STATE,

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
		DirectOutputConnection
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
