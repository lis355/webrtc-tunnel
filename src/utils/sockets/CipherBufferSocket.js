import BufferSocket from "./BufferSocket.js";
import symmetricBufferCipher from "../symmetricBufferCipher.js";

export default class CipherBufferSocket extends BufferSocket {
	static enhanceSocket(socket, options) {
		const bufferSocket = new CipherBufferSocket(options);
		bufferSocket.enhanceSocket(socket);

		return socket;
	}

	writeBuffer(buffer) {
		const encryptedBuffer = symmetricBufferCipher.encrypt(buffer);

		super.writeBuffer(encryptedBuffer);
	}

	pushBuffer(buffer) {
		let decryptedBuffer;
		try {
			decryptedBuffer = symmetricBufferCipher.decrypt(buffer);

			super.pushBuffer(decryptedBuffer);
		} catch {
			this.socket.emit("error", new Error("Decryption error"));
		}
	}
}
