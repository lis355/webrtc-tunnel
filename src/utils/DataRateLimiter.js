const RATE_LIMIT_INTERVAL_DEFAULT = 25; // 25ms

export default class DataRateLimiter {
	constructor(options) {
		this.options = options || {};
		this.options.rateLimitInterval = this.options.rateLimitInterval || RATE_LIMIT_INTERVAL_DEFAULT;

		if (typeof this.options.send !== "function") throw new Error("send function is required");

		this.rateLimitBytesPerSecond = this.options.rateLimitBytesPerSecond || 0;
		this.rateLimitBytesPerInterval = Math.floor(this.rateLimitBytesPerSecond * this.options.rateLimitInterval / 1000);
		this.clear();

		this.processRateLimitQueue = this.processRateLimitQueue.bind(this);
	}

	clear() {
		this.intervalStartProcessingTime = null;
		this.rateLimitTimer = clearTimeout(this.rateLimitTimer);
		this.rateLimitQueue = [];
	}

	send(chunk) {
		if (this.rateLimitBytesPerSecond === 0) {
			this.options.send(chunk);
		} else {
			this.rateLimitQueue.push(chunk);

			this.processRateLimitQueue();
		}
	}

	processRateLimitQueue() {
		if (this.processing ||
			this.rateLimitQueue.length === 0) return;

		this.processing = true;

		if (this.intervalStartProcessingTime &&
			performance.now() - this.intervalStartProcessingTime > this.options.rateLimitInterval) this.intervalStartProcessingTime = null;

		if (!this.intervalStartProcessingTime) {
			this.intervalStartProcessingTime = performance.now();
			this.intervalWrittenBytesAmount = 0;
		}

		this.rateLimitTimer = null;

		while (this.rateLimitQueue.length > 0 &&
			this.intervalWrittenBytesAmount < this.rateLimitBytesPerInterval) {
			const currentBuffer = this.rateLimitQueue[0];
			const remainingBytesAmount = this.rateLimitBytesPerInterval - this.intervalWrittenBytesAmount;

			let bufferToSend;
			if (currentBuffer.length <= remainingBytesAmount) {
				bufferToSend = currentBuffer;

				this.rateLimitQueue.shift();
			} else {
				const chunkToSend = currentBuffer.subarray(0, remainingBytesAmount);
				const remainingBuffer = currentBuffer.subarray(remainingBytesAmount);

				bufferToSend = chunkToSend;

				this.rateLimitQueue[0] = remainingBuffer;
			}

			this.options.send(bufferToSend);
			this.intervalWrittenBytesAmount += bufferToSend.length;
			// process.stdout.write("\x1b[A\x1b[K");
			// console.log("raw send", this.intervalStartProcessingTime, this.intervalWrittenBytesAmount);
		}

		if (this.rateLimitQueue.length > 0) this.rateLimitTimer = setTimeout(this.processRateLimitQueue, this.options.rateLimitInterval);

		this.processing = false;
	}
}
