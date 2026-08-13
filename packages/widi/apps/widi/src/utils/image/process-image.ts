import { type ImageResizeOptions, resizeImage } from "./resize.ts";
import { convertImageBytesToPng } from "./resize-core.ts";

export interface ProcessImageOptions {
	/** Whether to resize images to inline provider limits. Default: true. */
	autoResize?: boolean;
	/** Optional resize overrides. Uses resizeImage defaults when omitted. */
	resizeOptions?: ImageResizeOptions;
}

export interface ProcessedImageDimensions {
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

export type ProcessImageResult =
	| {
			ok: true;
			/** Base64-encoded image data in the final MIME type. */
			data: string;
			mimeType: string;
			/** Original MIME type when a format conversion happened. */
			convertedFrom?: string;
			/** Known only when the image was decoded for resizing. */
			dimensions?: ProcessedImageDimensions;
	  }
	| { ok: false; reason: string };

/**
 * Image processing seam for consumers. Override this to fake processing in
 * tests or delegate it to a remote environment.
 */
export type ImageProcessor = (
	bytes: Uint8Array,
	mimeType: string,
	options?: ProcessImageOptions,
) => Promise<ProcessImageResult>;

function baseMimeType(mimeType: string): string {
	return mimeType.split(";")[0]?.trim().toLowerCase() ?? mimeType.toLowerCase();
}

function normalizeSupportedImageMimeType(mimeType: string): string | null {
	switch (baseMimeType(mimeType)) {
		case "image/png":
			return "image/png";
		case "image/jpeg":
		case "image/jpg":
			return "image/jpeg";
		case "image/gif":
			return "image/gif";
		case "image/webp":
			return "image/webp";
		default:
			return null;
	}
}

interface NormalizedImage {
	bytes: Uint8Array;
	mimeType: string;
	convertedFrom?: string;
}

function normalizeImage(bytes: Uint8Array, mimeType: string): NormalizedImage | null {
	const normalizedMimeType = normalizeSupportedImageMimeType(mimeType);
	if (normalizedMimeType) {
		return { bytes, mimeType: normalizedMimeType };
	}

	// Formats providers cannot inline (currently BMP) are converted to PNG.
	const pngBytes = convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return { bytes: pngBytes, mimeType: "image/png", convertedFrom: baseMimeType(mimeType) };
}

function conversionResult(convertedFrom: string | undefined, finalMimeType: string): string | undefined {
	return convertedFrom && convertedFrom !== finalMimeType ? convertedFrom : undefined;
}

/**
 * Normalize an image to a provider-supported inline format and, unless
 * disabled, resize it to fit inline dimension and payload limits.
 */
export const processImage: ImageProcessor = async (bytes, mimeType, options) => {
	const autoResize = options?.autoResize ?? true;
	const normalized = normalizeImage(bytes, mimeType);
	if (!normalized) {
		return { ok: false, reason: "could not be converted to a supported inline image format" };
	}

	if (!autoResize) {
		return {
			ok: true,
			data: Buffer.from(normalized.bytes).toString("base64"),
			mimeType: normalized.mimeType,
			convertedFrom: conversionResult(normalized.convertedFrom, normalized.mimeType),
		};
	}

	const resized = await resizeImage(normalized.bytes, normalized.mimeType, options?.resizeOptions);
	if (!resized) {
		return { ok: false, reason: "could not be resized below the inline image size limit" };
	}

	return {
		ok: true,
		data: resized.data,
		mimeType: resized.mimeType,
		convertedFrom: conversionResult(normalized.convertedFrom, resized.mimeType),
		dimensions: {
			originalWidth: resized.originalWidth,
			originalHeight: resized.originalHeight,
			width: resized.width,
			height: resized.height,
			wasResized: resized.wasResized,
		},
	};
};
