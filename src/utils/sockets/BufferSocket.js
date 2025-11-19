const lengthBuffer = Buffer.allocUnsafe(4);

// maximumChunkSize 64 kB
export default class BufferSocket {
	static STATE_READ_LENGTH = 0;
	static STATE_READ_BUFFER = 1;

	static enhanceSocket(socket, options) {
		const bufferSocket = new BufferSocket(options);
		bufferSocket.enhanceSocket(socket);

		return socket;
	}

	constructor(options) {
		this.options = options || {};
		this.maximumChunkSize = this.options.maximumChunkSize = this.options.maximumChunkSize || 64 * 1024;

		this.state = BufferSocket.STATE_READ_LENGTH;
		this.chunks = [];
		this.chunksTotalSize = 0;
		this.sizeToRead = 4;

		this.processData = this.processData.bind(this);
	}

	enhanceSocket(socket) {
		this.socket = socket;

		this.socket.writeBuffer = this.writeBuffer.bind(this);

		this.socket.on("data", chunk => {
			this.chunks.push(chunk);
			this.chunksTotalSize += chunk.length;

			this.processData();
		});
	}

	writeBuffer(buffer) {
		if (buffer.length > 0x7FFFFFFF) throw new Error("Buffer too large");

		lengthBuffer.writeUInt32BE(buffer.length, 0);
		this.socket.write(lengthBuffer);

		if (buffer.length > this.maximumChunkSize) {
			for (let i = 0; i < buffer.length; i += this.maximumChunkSize) {
				this.socket.write(buffer.subarray(i, i + this.maximumChunkSize));
			}
		} else {
			this.socket.write(buffer);
		}
	}

	processData() {
		if (this.chunksTotalSize < this.sizeToRead) return;

		const concatenatedChunks = this.chunks.length > 1 ? Buffer.concat(this.chunks) : this.chunks[0];
		this.chunksTotalSize -= this.sizeToRead;
		this.chunks = this.chunksTotalSize !== 0 ? [concatenatedChunks.subarray(this.sizeToRead)] : [];

		switch (this.state) {
			case BufferSocket.STATE_READ_LENGTH:
				this.sizeToRead = concatenatedChunks.readUInt32BE(0);
				this.state = BufferSocket.STATE_READ_BUFFER;
				break;

			case BufferSocket.STATE_READ_BUFFER:
				const buffer = concatenatedChunks.length > this.sizeToRead ? concatenatedChunks.subarray(0, this.sizeToRead) : concatenatedChunks;
				this.pushBuffer(buffer);

				this.sizeToRead = 4;
				this.state = BufferSocket.STATE_READ_LENGTH;
				break;
		}

		process.nextTick(this.processData);
	}

	pushBuffer(buffer) {
		this.socket.emit("buffer", buffer);
	}
}
