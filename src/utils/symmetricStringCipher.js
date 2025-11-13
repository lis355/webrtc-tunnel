import crypto from "node:crypto";

import hash from "./hash.js";

import info from "../../package.json" with { type: "json" };

const chipherKey = crypto.createHash("sha256").update(hash(info)).digest();

function encrypt(str) {
	const iv = crypto.randomBytes(16);

	const cipher = crypto.createCipheriv("aes-256-gcm", chipherKey, iv);

	let encrypted = cipher.update(str, "utf8", "base64");
	encrypted += cipher.final("base64");

	const authTag = cipher.getAuthTag();

	return iv.toString("base64") + ":" + authTag.toString("base64") + ":" + encrypted;
}

function decrypt(encoded) {
	try {
		const [iv, authTag, data] = encoded.split(":");

		const decipher = crypto.createDecipheriv("aes-256-gcm", chipherKey, Buffer.from(iv, "base64"));
		decipher.setAuthTag(Buffer.from(authTag, "base64"));

		let decrypted = decipher.update(data, "base64", "utf8");
		decrypted += decipher.final("utf8");

		return decrypted;
	} catch {
		return "";
	}
}

export default {
	encrypt,
	decrypt
};
