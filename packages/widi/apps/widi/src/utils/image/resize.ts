import { Worker } from "node:worker_threads";
import { type ImageResizeOptions, type ResizedImage, resizeImageInProcess } from "./resize-core.ts";

/** Worker-backed facade for the shared image resize implementation. */

export type { ImageResizeOptions, ResizedImage } from "./resize-core.ts";

interface ResizeImageWorkerResponse {
	result?: ResizedImage | null;
	error?: string;
}

function isResizeImageWorkerResponse(value: unknown): value is ResizeImageWorkerResponse {
	return value !== null && typeof value === "object";
}

function toTransferableBytes(input: Uint8Array): Uint8Array<ArrayBuffer> {
	// Transfer detaches the buffer, so transfer a worker-owned copy and leave
	// the caller's bytes intact.
	return new Uint8Array(input);
}

async function resizeImageInWorker(
	workerUrl: URL,
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const worker = new Worker(workerUrl);
	try {
		const inputBytesForWorker = toTransferableBytes(inputBytes);
		return await new Promise<ResizedImage | null>((resolve, reject) => {
			let settled = false;
			const settle = (result: ResizedImage | null): void => {
				if (settled) return;
				settled = true;
				resolve(result);
			};
			const fail = (error: Error): void => {
				if (settled) return;
				settled = true;
				reject(error);
			};

			worker.once("message", (message: unknown) => {
				if (!isResizeImageWorkerResponse(message)) {
					fail(new Error("Invalid image resize worker response"));
					return;
				}
				if (message.error) {
					fail(new Error(message.error));
					return;
				}
				settle(message.result ?? null);
			});
			worker.once("error", fail);
			worker.once("exit", (code) => {
				if (!settled) {
					fail(new Error(`Image resize worker exited with code ${code}`));
				}
			});
			worker.postMessage({ inputBytes: inputBytesForWorker, mimeType, options }, [inputBytesForWorker.buffer]);
		});
	} finally {
		void worker.terminate().catch(() => undefined);
	}
}

/**
 * Resize an image to fit within the max dimensions and encoded payload size.
 *
 * Runs photon in a worker thread so WASM decoding, resizing, and encoding do
 * not block the main event loop. When the worker cannot be loaded, falls back
 * to in-process resizing so image reads still work.
 *
 * Source runs execute the .ts worker directly (Node strips types natively);
 * dist runs load the compiled .js worker next to this module.
 */
export async function resizeImage(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): Promise<ResizedImage | null> {
	const workerUrl = new URL(
		import.meta.url.endsWith(".ts") ? "./resize-worker.ts" : "./resize-worker.js",
		import.meta.url,
	);

	try {
		return await resizeImageInWorker(workerUrl, inputBytes, mimeType, options);
	} catch {
		return resizeImageInProcess(inputBytes, mimeType, options);
	}
}
