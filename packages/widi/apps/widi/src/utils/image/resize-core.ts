import { applyExifOrientation } from "./exif-orientation.ts";
import { loadPhoton, type PhotonImage, type PhotonModule } from "./photon.ts";

/** CPU-bound image conversion and resizing implementation. */

export interface ImageResizeOptions {
	/** Default: 2000. */
	maxWidth?: number;
	/** Default: 2000. */
	maxHeight?: number;
	/** Default: 4.5MB of base64 payload (below the Anthropic 5MB limit). */
	maxBytes?: number;
	/** Default: 80. */
	jpegQuality?: number;
}

export interface ResizedImage {
	/** Base64-encoded image data. */
	data: string;
	mimeType: string;
	originalWidth: number;
	originalHeight: number;
	width: number;
	height: number;
	wasResized: boolean;
}

const DEFAULT_RESIZE_MAX_BYTES = 4.5 * 1024 * 1024;

const DEFAULT_RESIZE_OPTIONS: Required<ImageResizeOptions> = {
	maxWidth: 2000,
	maxHeight: 2000,
	maxBytes: DEFAULT_RESIZE_MAX_BYTES,
	jpegQuality: 80,
};

interface EncodedCandidate {
	data: string;
	encodedSize: number;
	mimeType: string;
}

function encodeCandidate(buffer: Uint8Array, mimeType: string): EncodedCandidate {
	const data = Buffer.from(buffer).toString("base64");
	return { data, encodedSize: Buffer.byteLength(data, "utf-8"), mimeType };
}

function decodeWithOrientation(photon: PhotonModule, bytes: Uint8Array): PhotonImage {
	const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
	const image = applyExifOrientation(photon, rawImage, bytes);
	if (image !== rawImage) rawImage.free();
	return image;
}

/**
 * Decode image bytes, apply EXIF orientation, and re-encode as PNG.
 * Returns null when photon is unavailable or the bytes cannot be decoded.
 */
export function convertImageBytesToPng(bytes: Uint8Array): Uint8Array | null {
	const photon = loadPhoton();
	if (!photon) {
		return null;
	}

	try {
		const image = decodeWithOrientation(photon, bytes);
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		return null;
	}
}

/**
 * Resize an image to fit within the max dimensions and encoded payload size.
 * Returns null when photon is unavailable, the bytes cannot be decoded, or no
 * encoding fits under maxBytes.
 *
 * Strategy for staying under maxBytes:
 * 1. Resize to maxWidth/maxHeight.
 * 2. Try both PNG and JPEG at decreasing quality, pick the first that fits.
 * 3. Progressively reduce dimensions down to 1x1.
 */
export function resizeImageInProcess(
	inputBytes: Uint8Array,
	mimeType: string,
	options?: ImageResizeOptions,
): ResizedImage | null {
	const opts = { ...DEFAULT_RESIZE_OPTIONS, ...options };
	const inputBase64Size = Math.ceil(inputBytes.byteLength / 3) * 4;

	const photon = loadPhoton();
	if (!photon) {
		return null;
	}

	let image: PhotonImage | undefined;
	try {
		image = decodeWithOrientation(photon, inputBytes);
		const decodedImage = image;

		const originalWidth = decodedImage.get_width();
		const originalHeight = decodedImage.get_height();

		// Already within the dimension and encoded-size limits.
		if (originalWidth <= opts.maxWidth && originalHeight <= opts.maxHeight && inputBase64Size < opts.maxBytes) {
			return {
				data: Buffer.from(inputBytes).toString("base64"),
				mimeType,
				originalWidth,
				originalHeight,
				width: originalWidth,
				height: originalHeight,
				wasResized: false,
			};
		}

		// Initial target dimensions preserving aspect ratio within the limits.
		let targetWidth = originalWidth;
		let targetHeight = originalHeight;
		if (targetWidth > opts.maxWidth) {
			targetHeight = Math.round((targetHeight * opts.maxWidth) / targetWidth);
			targetWidth = opts.maxWidth;
		}
		if (targetHeight > opts.maxHeight) {
			targetWidth = Math.round((targetWidth * opts.maxHeight) / targetHeight);
			targetHeight = opts.maxHeight;
		}

		const tryEncodings = (width: number, height: number, jpegQualities: number[]): EncodedCandidate[] => {
			const resized = photon.resize(decodedImage, width, height, photon.SamplingFilter.Lanczos3);
			try {
				const candidates: EncodedCandidate[] = [encodeCandidate(resized.get_bytes(), "image/png")];
				for (const quality of jpegQualities) {
					candidates.push(encodeCandidate(resized.get_bytes_jpeg(quality), "image/jpeg"));
				}
				return candidates;
			} finally {
				resized.free();
			}
		};

		const qualitySteps = Array.from(new Set([opts.jpegQuality, 85, 70, 55, 40]));
		let currentWidth = targetWidth;
		let currentHeight = targetHeight;

		while (true) {
			const candidates = tryEncodings(currentWidth, currentHeight, qualitySteps);
			for (const candidate of candidates) {
				if (candidate.encodedSize < opts.maxBytes) {
					return {
						data: candidate.data,
						mimeType: candidate.mimeType,
						originalWidth,
						originalHeight,
						width: currentWidth,
						height: currentHeight,
						wasResized: true,
					};
				}
			}

			if (currentWidth === 1 && currentHeight === 1) {
				break;
			}

			const nextWidth = currentWidth === 1 ? 1 : Math.max(1, Math.floor(currentWidth * 0.75));
			const nextHeight = currentHeight === 1 ? 1 : Math.max(1, Math.floor(currentHeight * 0.75));
			if (nextWidth === currentWidth && nextHeight === currentHeight) {
				break;
			}

			currentWidth = nextWidth;
			currentHeight = nextHeight;
		}

		return null;
	} catch {
		return null;
	} finally {
		image?.free();
	}
}
