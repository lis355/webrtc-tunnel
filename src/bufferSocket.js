const STATE_READ_LENGTH = 0;
const STATE_READ_BUFFER = 1;

const lengthBuffer = Buffer.allocUnsafe(4);

// maximumChunkSize 64 kB
export function enhanceSocket(socket, { maximumChunkSize = 64 * 1024 } = {}) {
	socket.sendBuffer = buffer => {
		if (buffer.length > 0x7FFFFFFF) throw new Error("Buffer too large");

		lengthBuffer.writeUInt32BE(buffer.length, 0);
		socket.write(lengthBuffer);

		if (buffer.length > maximumChunkSize) {
			for (let i = 0; i < buffer.length; i += maximumChunkSize) {
				socket.write(buffer.subarray(i, i + maximumChunkSize));
			}
		} else {
			socket.write(buffer);
		}
	};

	socket.state = STATE_READ_LENGTH;
	socket.chunks = [];
	socket.chunksTotalSize = 0;
	socket.sizeToRead = 4;

	socket.on("data", chunk => {
		socket.chunks.push(chunk);
		socket.chunksTotalSize += chunk.length;

		socket.processData();
	});

	socket.processData = () => {
		if (socket.chunksTotalSize < socket.sizeToRead) return;

		const concatenatedChunks = socket.chunks.length > 1 ? Buffer.concat(socket.chunks) : socket.chunks[0];
		socket.chunksTotalSize -= socket.sizeToRead;
		socket.chunks = socket.chunksTotalSize !== 0 ? [concatenatedChunks.subarray(socket.sizeToRead)] : [];

		switch (socket.state) {
			case STATE_READ_LENGTH:
				socket.sizeToRead = concatenatedChunks.readUInt32BE(0);
				socket.state = STATE_READ_BUFFER;
				break;

			case STATE_READ_BUFFER:
				const buffer = concatenatedChunks.length > socket.sizeToRead ? concatenatedChunks.subarray(0, socket.sizeToRead) : concatenatedChunks;
				socket.emit("buffer", buffer);

				socket.sizeToRead = 4;
				socket.state = STATE_READ_LENGTH;
				break;
		}

		process.nextTick(socket.processData);
	};

	return socket;
}
