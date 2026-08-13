import { resolve } from "node:path";
import {
	type CodingToolFileOperations,
	createLocalCodingToolFileOperations,
	isMissingPathError,
} from "./operations.ts";

const fileMutationQueues = new Map<string, Promise<void>>();
let registrationQueue = Promise.resolve();

export interface FileMutationQueueOptions {
	operations?: Pick<CodingToolFileOperations, "realpath">;
}

export async function withFileMutationQueue<T>(
	filePath: string,
	fn: () => Promise<T>,
	options: FileMutationQueueOptions = {},
): Promise<T> {
	const operations = options.operations ?? createLocalCodingToolFileOperations();
	const registration = registrationQueue.then(async () => {
		const key = await getMutationQueueKey(filePath, operations);
		const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();

		let releaseNext!: () => void;
		const nextQueue = new Promise<void>((resolveQueue) => {
			releaseNext = resolveQueue;
		});
		const chainedQueue = currentQueue.then(() => nextQueue);
		fileMutationQueues.set(key, chainedQueue);

		return { key, currentQueue, chainedQueue, releaseNext };
	});
	registrationQueue = registration.then(
		() => undefined,
		() => undefined,
	);

	const { key, currentQueue, chainedQueue, releaseNext } = await registration;
	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) {
			fileMutationQueues.delete(key);
		}
	}
}

async function getMutationQueueKey(
	filePath: string,
	operations: Pick<CodingToolFileOperations, "realpath">,
): Promise<string> {
	const resolvedPath = resolve(filePath);
	try {
		return await operations.realpath(resolvedPath);
	} catch (error) {
		if (isMissingPathError(error)) {
			return resolvedPath;
		}
		throw error;
	}
}
