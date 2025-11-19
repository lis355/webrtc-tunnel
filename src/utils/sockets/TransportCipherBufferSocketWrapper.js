import net from "node:net";

import symmetricBufferCipher from "../symmetricBufferCipher.js";

export default class TransportCipherBufferSocketWrapper extends net.Socket {
	writeBuffer(buffer) {
		const encryptedBuffer = symmetricBufferCipher.encrypt(buffer);

		this.emit("writeBuffer", encryptedBuffer);
	}

	pushBuffer(buffer) {
		let decryptedBuffer;
		try {
			decryptedBuffer = symmetricBufferCipher.decrypt(buffer);
		} catch {
			this.emit("error", new Error("Decryption error"));
		}

		this.emit("buffer", decryptedBuffer);
	}
}
