export default function log(...args) {
	console.log(`[${new Date().toISOString()}]:`, ...args);
};

