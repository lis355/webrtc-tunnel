import chalk from "chalk";

export function log(...args) {
	console.log(chalk.blue(`[${new Date().toISOString()}]:`), ...args);
}

export function createLog(...header) {
	return function (...args) {
		log(...header, ...args);
	};
}

export const LOG_LEVELS = {
	INFO: 0,
	DETAILED: 1,
	DEBUG: 2
};

let logLevel = LOG_LEVELS.INFO;

export function getLogLevel() {
	return logLevel;
}

export function setLogLevel(level) {
	if (level === LOG_LEVELS.INFO ||
		level === LOG_LEVELS.DETAILED ||
		level === LOG_LEVELS.DEBUG) logLevel = level;
	else if (level === "info") logLevel = LOG_LEVELS.INFO;
	else if (level === "detailed") logLevel = LOG_LEVELS.DETAILED;
	else if (level === "debug") logLevel = LOG_LEVELS.DEBUG;
	else logLevel = LOG_LEVELS.INFO;
}

export function ifLog(level) {
	return level <= logLevel;
}
