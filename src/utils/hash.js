import crypto from "node:crypto";

// What is the fastest node.js hashing algorithm
// https://medium.com/@chris_72272/what-is-the-fastest-node-js-hashing-algorithm-c15c1a0e164e
export default function hash(...objects) {
	return crypto.createHash("sha1").update(objects.map(JSON.stringify).join()).digest("hex");
};
