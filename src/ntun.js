import crypto from "node:crypto";
import EventEmitter from "node:events";
import net from "node:net";

import * as ws from "ws";
import chalk from "chalk";
import msgpack from "msgpack5";
import socks from "socksv5";

import { createLog, ifLog, LOG_LEVELS } from "./utils/log.js";
import DataRateLimiter from "./utils/DataRateLimiter.js";
import symmetricBufferCipher from "./utils/symmetricBufferCipher.js";

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

const packer = msgpack();

function objectToBuffer(obj) {
	return packer.encode(obj);
}

function bufferToObject(buffer) {
	return packer.decode(buffer);
}

const LOCALHOST = "127.0.0.1";
const ALL_INTERFACES = "0.0.0.0";

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
		return int32md5XorHash(socket.localAddress + socket.localPort + socket.remoteAddress + socket.remotePort);
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
		this.workingState = WORKING_STATE.IDLE;

		if (ifLog(LOG_LEVELS.DETAILED)) this.log("stopped");

		this.emit("stopped");
	}

	handleOnTransportConnected() {
		this.subscribeOnConnectionMultiplexer();

		this.connectionMultiplexer.socket = this.node.transport.transportSocket;
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

		// такое возможно, если на обоих концах транспорта сокеты оборвали соединения
		if (!connection) return;

		connection.wasClosed = true;

		if (errorMessage) {
			if (ifLog(LOG_LEVELS.DETAILED)) this.log(`error with [${connection.destinationHost}:${connection.destinationPort}]`, errorMessage);
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
			close: this.handleConnectionSocketOnClose.bind(this, connection),
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
			// .off("close", connection.listeners.close)
			.off("data", connection.listeners.data);

		this.connections.delete(connection.connectionId);
	}

	handleConnectionSocketOnError(connection, error) {
		if (ifLog(LOG_LEVELS.INFO)) this.log(`error with [${connection.destinationHost}:${connection.destinationPort}]`, error.code || error.message);

		connection.errorMessage = error.code || error.message;
	}

	handleConnectionSocketOnConnect(connection) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`connected with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

		connection.destinationHost = connection.socket.remoteAddress;
		connection.destinationPort = connection.socket.remotePort;

		connection.connected = true;
	}

	handleConnectionSocketOnReady(connection) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`ready with [${connection.socket.remoteAddress}:${connection.socket.remotePort}]`);

		while (connection.messages.length > 0) connection.socket.write(connection.messages.shift());
	}

	handleConnectionSocketOnClose(connection) {
		if (ifLog(LOG_LEVELS.DETAILED)) this.log(`closed with [${connection.destinationHost}:${connection.destinationPort}]`);

		connection.connected = false;

		if (connection.wasClosed) return;

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

		// const destinationHostBufferSizeBuffer = Buffer.allocUnsafe(2);
		// const destinationHostBuffer = Buffer.from(destinationHost, "utf8");
		// destinationHostBufferSizeBuffer.writeUInt16LE(destinationHostBuffer.length, 0);
		// const destinationPortBuffer = Buffer.allocUnsafe(2);
		// destinationPortBuffer.writeUInt16LE(destinationPort, 0);

		// this.sendMessage(connectionId, ConnectionMultiplexer.MESSAGE_TYPES.CONNECT, [
		// 	destinationHostBufferSizeBuffer,
		// 	destinationHostBuffer,
		// 	destinationPortBuffer
		// ]);

		if (ifLog(LOG_LEVELS.DEBUG)) connectionMultiplexerLog("send", "CONN", connectionId, destinationHost, destinationPort);
	}

	sendMessageClose(connectionId, errorMessage = null) {
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPES.CLOSE, connectionId, errorMessage);

		// const errorMessageSizeBuffer = Buffer.allocUnsafe(2);
		// const errorMessageBuffer = Buffer.from(errorMessage || "", "utf8");
		// errorMessageSizeBuffer.writeUInt16LE(errorMessageBuffer.length, 0);

		// this.sendMessage(connectionId, ConnectionMultiplexer.MESSAGE_TYPES.CLOSE, [
		// 	errorMessageSizeBuffer,
		// 	errorMessageBuffer
		// ]);

		if (ifLog(LOG_LEVELS.DEBUG)) connectionMultiplexerLog("send", "CLSE", connectionId, errorMessage);
	}

	sendMessageData(connectionId, data) {
		this.sendMessage(ConnectionMultiplexer.MESSAGE_TYPES.DATA, connectionId, data);

		// this.sendMessage(connectionId, ConnectionMultiplexer.MESSAGE_TYPES.DATA, [
		// 	data
		// ]);

		if (ifLog(LOG_LEVELS.DEBUG)) {
			connectionMultiplexerLog("send", "DATA", connectionId, data.length);
			// console.log(getHexTable(data));
		}
	}

	sendMessage(messageType, connectionId, ...args) {
		const message = [messageType, connectionId, ...args];
		const buffer = objectToBuffer(message);

		this.socket.writeBuffer(buffer);
	}

	// sendMessage(connectionId, messageType, buffers) {
	// 	const connectionIdBuffer = Buffer.allocUnsafe(4);
	// 	connectionIdBuffer.writeUInt32LE(connectionId, 0);
	// 	const messageTypeBuffer = Buffer.allocUnsafe(1);
	// 	messageTypeBuffer.writeUInt8(messageType, 0);

	// 	this.socket.writeBuffer(Buffer.concat([
	// 		connectionIdBuffer,
	// 		messageTypeBuffer,
	// 		...buffers
	// 	]));
	// }

	async handleSocketOnBuffer(buffer) {
		const message = bufferToObject(buffer);
		const [messageType, connectionId, ...args] = message;

		// let position = 0;
		// const connectionId = buffer.readUInt32LE(position); position += 4;
		// const messageType = buffer.readUInt8(position); position += 1;

		switch (messageType) {
			case ConnectionMultiplexer.MESSAGE_TYPES.CONNECT: {
				const [destinationHost, destinationPort] = args;

				// const destinationHostLength = buffer.readUInt16LE(position); position += 2;
				// const destinationHost = buffer.subarray(position, position + destinationHostLength).toString("utf8"); position += destinationHostLength;
				// const destinationPort = buffer.readUInt16LE(position); position += 2;

				if (ifLog(LOG_LEVELS.DEBUG)) connectionMultiplexerLog("recv", "CONN", connectionId, destinationHost, destinationPort);

				this.emit("connect", connectionId, destinationHost, destinationPort);

				break;
			}
			case ConnectionMultiplexer.MESSAGE_TYPES.CLOSE: {
				const [errorMessage] = args;

				// const errorMessageLength = buffer.readUInt16LE(position); position += 2;
				// const errorMessage = buffer.subarray(position, position + errorMessageLength).toString("utf8"); position += errorMessageLength;

				if (ifLog(LOG_LEVELS.DEBUG)) connectionMultiplexerLog("recv", "CLSE", connectionId, errorMessage);

				this.emit("close", connectionId, errorMessage);

				break;
			}
			case ConnectionMultiplexer.MESSAGE_TYPES.DATA: {
				const [data] = args;

				// const data = buffer.subarray(position);

				if (ifLog(LOG_LEVELS.DEBUG)) {
					connectionMultiplexerLog("recv", "DATA", connectionId, data.length);
					// console.log(getHexTable(data));
				}

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

		if (ifLog(LOG_LEVELS.INFO)) this.log(`[${connection.socket.remoteAddress}:${connection.socket.remotePort}] proxies to [${info.dstAddr}:${info.dstPort}]`);

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
		if (ifLog(LOG_LEVELS.INFO)) this.log(`output internet connection to [${destinationHost}:${destinationPort}]`);

		const destinationSocket = net.connect(destinationPort, destinationHost);

		const connection = this.createConnection(connectionId, destinationSocket);
		connection.destinationHost = destinationHost;
		connection.destinationPort = destinationPort;
	}
}

class TransportSocketMiddleware {
	performOutBuffer(buffer) {
		return buffer;
	}

	performInBuffer(buffer) {
		return buffer;
	}
}

class TransportSocketSimpleCipherMiddleware extends TransportSocketMiddleware {
	performOutBuffer(buffer) {
		return symmetricBufferCipher.encrypt(buffer);
	}

	performInBuffer(buffer) {
		return symmetricBufferCipher.decrypt(buffer);
	}
}

const MAXIMUM_BUFFER_SIZE = 256 * 1024 ** 2; // 256 mB
const MAXIMUM_CHUNK_SIZE = 128 * 1024; // 128 kB

// writeBuffer
// event:buffer
class TransportSocket extends EventEmitter {
	static STATE_READ_LENGTH = 0;
	static STATE_READ_BUFFER = 1;

	constructor(options) {
		super();

		this.options = options || {};
		this.maximumChunkSize = this.options.maximumChunkSize = this.options.maximumChunkSize || MAXIMUM_CHUNK_SIZE;

		if (typeof this.options.write !== "function") throw new Error("write must be a function");

		this.clear();

		this.handleOnData = this.handleOnData.bind(this);

		this.on("data", this.handleOnData);

		this.middlewares = [];

		if (this.options.cipher === undefined ||
			this.options.cipher) this.middlewares.push(new TransportSocketSimpleCipherMiddleware());

		if (this.options.rateLimit &&
			this.options.rateLimit.bytesPerSecond) {
			this.dataRateLimiter = new DataRateLimiter({
				rateLimitBytesPerSecond: this.options.rateLimit.bytesPerSecond,
				send: chunk => this.writeRawChunk(chunk)
			});
		}
	}

	clear() {
		this.sizeToRead = 4;
		this.state = TransportSocket.STATE_READ_LENGTH;
		this.chunks = [];
		this.chunksTotalSize = 0;

		if (this.dataRateLimiter) this.dataRateLimiter.clear();
	}

	writeBuffer(buffer) {
		if (buffer.length > MAXIMUM_BUFFER_SIZE) throw new Error("Buffer too large");

		try {
			for (const middlewares of this.middlewares) buffer = middlewares.performOutBuffer(buffer);
		} catch (error) {
			this.emit("error", error);

			return;
		}

		const lengthBuffer = Buffer.allocUnsafe(4);
		lengthBuffer.writeUInt32BE(buffer.length, 0);
		this.writeData(lengthBuffer);

		if (buffer.length > this.maximumChunkSize) {
			for (let i = 0; i < buffer.length; i += this.maximumChunkSize) {
				this.writeData(buffer.subarray(i, i + this.maximumChunkSize));
			}
		} else {
			this.writeData(buffer);
		}
	}

	writeData(chunk) {
		if (this.dataRateLimiter) this.dataRateLimiter.send(chunk);
		else this.writeRawChunk(chunk);
	}

	writeRawChunk(chunk) {
		this.options.write(chunk);
	}

	handleOnData(chunk) {
		this.chunks.push(chunk);
		this.chunksTotalSize += chunk.length;

		this.processData();
	}

	processData() {
		while (this.chunksTotalSize >= this.sizeToRead) {
			let chunksToReadAmount = 0;
			let chunksToReadSize = 0;
			while (chunksToReadSize < this.sizeToRead) chunksToReadSize += this.chunks[chunksToReadAmount++].length;

			if (chunksToReadAmount > 1) this.chunks.unshift(Buffer.concat(this.chunks.splice(0, chunksToReadAmount)));

			let chunk = this.chunks[0];
			let nextSizeToRead;
			switch (this.state) {
				case TransportSocket.STATE_READ_LENGTH:
					nextSizeToRead = chunk.readUInt32BE(0);
					this.state = TransportSocket.STATE_READ_BUFFER;
					break;

				case TransportSocket.STATE_READ_BUFFER:
					this.pushBuffer(chunk.length > this.sizeToRead ? chunk.subarray(0, this.sizeToRead) : chunk);

					nextSizeToRead = 4;
					this.state = TransportSocket.STATE_READ_LENGTH;
					break;
			}

			if (chunk.length > this.sizeToRead) {
				this.chunks[0] = chunk.subarray(this.sizeToRead);
			} else {
				this.chunks.shift();
			}

			this.chunksTotalSize -= this.sizeToRead;

			this.sizeToRead = nextSizeToRead;
		}
	}

	pushBuffer(buffer) {
		try {
			for (const middlewares of this.middlewares) buffer = middlewares.performInBuffer(buffer);

			this.emit("buffer", buffer);
		} catch (error) {
			this.emit("error", error);
		}
	}

	close() {
		this.clear();
	}
}

class Transport extends EventEmitter {
	constructor(options) {
		super();

		this.createLog();

		this.options = options;
		this._transportSocket = null;
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

	get transportSocket() {
		return this._transportSocket;
	}

	set transportSocket(newSocket) {
		if (this._transportSocket === newSocket) return;

		if (!newSocket) {
			this.printDisconnectedLog();

			this.emit("disconnected");
		}

		this._transportSocket = newSocket;

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
		return Boolean(this.transportSocket);
	}
}

class ClientServerTransport extends Transport {
	constructor(options) {
		super(options);

		this.host = this.options.host || ALL_INTERFACES;
		this.port = this.options.port;

		this.handleSocketOnError = this.handleSocketOnError.bind(this);
		this.handleSocketOnClose = this.handleSocketOnClose.bind(this);
	}

	createTransportSocket(socket) { throw new Error("Not implemented"); }

	handleSocketOnError(error) {
		let errorMessage = error.message;
		if (error.code === "ECONNREFUSED") errorMessage = "connection refused";
		else if (error.code === "ECONNRESET") errorMessage = "connection reset";
		else if (error.code === "ETIMEDOUT") errorMessage = "connection timeout";

		if (ifLog(LOG_LEVELS.INFO)) this.log("error", errorMessage);
	}

	handleSocketOnClose() {
		if (this.transportSocket) {
			this.transportSocket.close();

			this.transportSocket = null;
		}

		this.socket
			.off("error", this.handleSocketOnError)
			.off("close", this.handleSocketOnClose);

		this.socket = null;
	}

	printConnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("connected", chalk.magenta(`${this.socket.localAddress}:${this.socket.localPort}`), "--", chalk.magenta(`${this.socket.remoteAddress}:${this.socket.remotePort}`));
	}

	printDisconnectedLog() {
		if (ifLog(LOG_LEVELS.INFO)) this.log("disconnected", chalk.magenta(`${this.socket.remoteAddress}:${this.socket.remotePort}`));
	}
}

class ServerTransport extends ClientServerTransport {
	constructor(options) {
		super(options);

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

		this.listenServer(this.host);
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

		if (this.socket) this.socket.destroy();

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
		if (this.transportSocket) {
			// drop other connection

			if (ifLog(LOG_LEVELS.INFO)) this.log("server already has a current transport connected socket, drop other connection", chalk.magenta(`${socket.remoteAddress}:${socket.remotePort}`));

			socket.destroy();
		} else {
			this.socket = socket;
			this.socket
				.on("error", this.handleSocketOnError)
				.on("close", this.handleSocketOnClose);

			this.transportSocket = this.createTransportSocket(this.socket);
		}
	}
}

function createTransportSocketForTCPSocket(socket, options) {
	const transportSocket = new TransportSocket({
		write: data => transportSocket.socket.write(data),
		...options
	});

	const onClose = () => {
		transportSocket.socket.off("close", onClose);
		transportSocket.socket.off("data", onData);

		transportSocket.close();
	};

	const onData = chunk => transportSocket.handleOnData(chunk);

	transportSocket.socket = socket;
	transportSocket.socket
		.on("close", onClose)
		.on("data", onData);

	return transportSocket;
}

class TCPServerTransport extends ServerTransport {
	createLog() {
		this.log = createLog("[transport]", "[tcp-server]");
	}

	createServer() {
		this.server = net.createServer();
	}

	listenServer(host) {
		this.server.listen(this.port, host);
	}

	createTransportSocket(socket) {
		return createTransportSocketForTCPSocket(socket, this.options);
	}
}

const TRANSPORT_CONNECTION_TIMEOUT = 3 * 1000;

class ClientTransport extends ClientServerTransport {
	constructor(options) {
		super(options);

		this.attemptToConnect = this.attemptToConnect.bind(this);
		this.handleSocketOnConnect = this.handleSocketOnConnect.bind(this);
	}

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

			this.socket.destroy();
		}

		this.emitStopped();
	}

	createSocket() { throw new Error("Not implemented"); }

	createTransportSocket(socket) { throw new Error("Not implemented"); }

	attemptToConnect() {
		if (!this.connecting) return;

		if (ifLog(LOG_LEVELS.INFO)) this.log("attempting to connect to", chalk.magenta(`${this.host}:${this.port}`));

		this.socket = this.createSocket();
		this.socket
			.on("error", this.handleSocketOnError)
			.on("close", this.handleSocketOnClose)
			.on("connect", this.handleSocketOnConnect);
	}

	handleSocketOnClose() {
		this.socket
			.off("connect", this.handleSocketOnConnect);

		super.handleSocketOnClose();

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

	handleSocketOnConnect() {
		this.socketDestroyedByStopCalled = false;

		this.socket
			.off("error", this.handleSocketOnError)
			.off("close", this.handleSocketOnClose)
			.off("connect", this.handleSocketOnConnect);

		this.transportSocket = this.createTransportSocket(this.socket);

		this.connecting = false;
	}
}

class TCPClientTransport extends ClientTransport {
	createLog() {
		this.log = createLog("[transport]", "[tcp-socket]");
	}

	createSocket() {
		return net.connect(this.port, this.host);
	}

	createTransportSocket(socket) {
		return createTransportSocketForTCPSocket(socket, this.options);
	}
}

function patchWebSocket(webSocket) {
	Object.defineProperty(webSocket, "localAddress", { get: () => webSocket._socket.localAddress });
	Object.defineProperty(webSocket, "localPort", { get: () => webSocket._socket.localPort });
	Object.defineProperty(webSocket, "remoteAddress", { get: () => webSocket._socket.remoteAddress });
	Object.defineProperty(webSocket, "remotePort", { get: () => webSocket._socket.remotePort });

	webSocket.on("open", () => webSocket.emit("connect"));
	webSocket.destroy = () => webSocket.terminate();

	return webSocket;
}

function createTransportSocketForWebSocket(webSocket, options) {
	const transportSocket = new TransportSocket({
		write: data => transportSocket.webSocket.send(data),
		...options
	});

	const onClose = () => {
		transportSocket.webSocket.off("close", onClose);
		transportSocket.webSocket.off("message", onMessage);

		transportSocket.close();
	};

	const onMessage = message => transportSocket.handleOnData(message);

	transportSocket.webSocket = webSocket;
	transportSocket.webSocket
		.on("close", onClose)
		.on("message", onMessage);

	return transportSocket;
}

class WebSocketServerTransport extends ServerTransport {
	createLog() {
		this.log = createLog("[transport]", "[ws-server]");
	}

	createServer() {
		this.server = new ws.WebSocketServer({ host: this.host, port: this.port });
	}

	listenServer(host) {
		// listen called in WebSocketServer constructor
	}

	createTransportSocket(socket) {
		return createTransportSocketForWebSocket(socket, this.options);
	}

	handleServerOnConnection(socket) {
		super.handleServerOnConnection(patchWebSocket(socket));
	}
}

class WebSocketClientTransport extends ClientTransport {
	createLog() {
		this.log = createLog("[transport]", "[ws-socket]");
	}

	createSocket() {
		return patchWebSocket(new ws.WebSocket(`ws://${this.host}:${this.port}`));
	}

	createTransportSocket(socket) {
		return createTransportSocketForWebSocket(socket, this.options);
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
		ServerTransport,
		ClientTransport,

		TCPServerTransport,
		TCPClientTransport,

		WebSocketServerTransport,
		WebSocketClientTransport
	}
};
