/** Shared image utility behavior, independent of the read tool adapter. */
import { describe, expect, it } from "vitest";
import { applyExifOrientation, getExifOrientation } from "../../src/utils/image/exif-orientation.ts";
import { detectSupportedImageMimeType } from "../../src/utils/image/mime.ts";
import { loadPhoton } from "../../src/utils/image/photon.ts";
import { processImage } from "../../src/utils/image/process-image.ts";
import { resizeImage } from "../../src/utils/image/resize.ts";
import { convertImageBytesToPng, resizeImageInProcess } from "../../src/utils/image/resize-core.ts";

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

function makePngHeader(chunkType = "IHDR"): Buffer {
	return Buffer.concat([
		Buffer.from(PNG_SIGNATURE),
		Buffer.from([0, 0, 0, 13]),
		Buffer.from(chunkType, "ascii"),
		Buffer.alloc(13 + 4),
	]);
}

function makeAnimatedPng(): Buffer {
	// IHDR chunk followed by an acTL chunk before any IDAT.
	return Buffer.concat([makePngHeader(), Buffer.from([0, 0, 0, 8]), Buffer.from("acTL", "ascii"), Buffer.alloc(8 + 4)]);
}

/** Minimal 24-bit BMP with a BITMAPINFOHEADER and solid red pixels. */
function makeBmp(width: number, height: number): Buffer {
	const rowSize = Math.ceil((width * 3) / 4) * 4;
	const pixelDataSize = rowSize * height;
	const fileSize = 54 + pixelDataSize;
	const buffer = Buffer.alloc(fileSize);
	buffer.write("BM", 0, "ascii");
	buffer.writeUInt32LE(fileSize, 2);
	buffer.writeUInt32LE(54, 10);
	buffer.writeUInt32LE(40, 14);
	buffer.writeInt32LE(width, 18);
	buffer.writeInt32LE(height, 22);
	buffer.writeUInt16LE(1, 26);
	buffer.writeUInt16LE(24, 28);
	buffer.writeUInt32LE(pixelDataSize, 34);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const offset = 54 + y * rowSize + x * 3;
			buffer[offset] = 0x00; // blue
			buffer[offset + 1] = 0x00; // green
			buffer[offset + 2] = 0xff; // red
		}
	}
	return buffer;
}

/** SOI plus an APP1 EXIF segment carrying only an orientation entry. */
function makeJpegExifBytes(orientation: number): Uint8Array {
	const tiff = Buffer.concat([
		Buffer.from("II", "ascii"),
		Buffer.from([0x2a, 0x00, 0x08, 0x00, 0x00, 0x00]),
		Buffer.from([0x01, 0x00]),
		Buffer.from([0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00]),
		Buffer.from([orientation, 0x00, 0x00, 0x00]),
		Buffer.from([0x00, 0x00, 0x00, 0x00]),
	]);
	const payload = Buffer.concat([Buffer.from("Exif\0\0", "ascii"), tiff]);
	const segmentLength = payload.length + 2;
	return Buffer.concat([
		Buffer.from([0xff, 0xd8, 0xff, 0xe1]),
		Buffer.from([(segmentLength >> 8) & 0xff, segmentLength & 0xff]),
		payload,
	]);
}

function requirePhoton() {
	const photon = loadPhoton();
	if (!photon) {
		throw new Error("photon must be loadable in the test environment");
	}
	return photon;
}

function makePngBytes(width: number, height: number, pixels?: readonly [number, number, number, number][]): Uint8Array {
	const photon = requirePhoton();
	const raw = new Uint8Array(width * height * 4);
	for (let index = 0; index < width * height; index++) {
		const pixel = pixels?.[index] ?? [255, 0, 0, 255];
		raw.set(pixel, index * 4);
	}
	const image = new photon.PhotonImage(raw, width, height);
	try {
		return new Uint8Array(image.get_bytes());
	} finally {
		image.free();
	}
}

describe("image mime detection", () => {
	it("detects JPEG and rejects JPEG-LS", () => {
		expect(detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00]))).toBe("image/jpeg");
		expect(detectSupportedImageMimeType(Buffer.from([0xff, 0xd8, 0xff, 0xf7, 0x00]))).toBeNull();
	});

	it("detects PNG and rejects truncated or animated PNG", () => {
		expect(detectSupportedImageMimeType(makePngHeader())).toBe("image/png");
		// Signature only, no IHDR chunk.
		expect(detectSupportedImageMimeType(Buffer.from(PNG_SIGNATURE))).toBeNull();
		// Signature followed by a non-IHDR chunk.
		expect(detectSupportedImageMimeType(makePngHeader("JUNK"))).toBeNull();
		expect(detectSupportedImageMimeType(makeAnimatedPng())).toBeNull();
	});

	it("detects GIF variants", () => {
		expect(detectSupportedImageMimeType(Buffer.from("GIF87a1234", "ascii"))).toBe("image/gif");
		expect(detectSupportedImageMimeType(Buffer.from("GIF89a1234", "ascii"))).toBe("image/gif");
		expect(detectSupportedImageMimeType(Buffer.from("GIF00a1234", "ascii"))).toBeNull();
	});

	it("detects WEBP only with both RIFF and WEBP markers", () => {
		expect(detectSupportedImageMimeType(Buffer.from("RIFF0000WEBP", "ascii"))).toBe("image/webp");
		expect(detectSupportedImageMimeType(Buffer.from("RIFF0000WAVE", "ascii"))).toBeNull();
	});

	it("detects BMP and rejects malformed BMP headers", () => {
		expect(detectSupportedImageMimeType(makeBmp(2, 2))).toBe("image/bmp");
		const badPlanes = makeBmp(2, 2);
		badPlanes.writeUInt16LE(3, 26);
		expect(detectSupportedImageMimeType(badPlanes)).toBeNull();
		const badOffset = makeBmp(2, 2);
		badOffset.writeUInt32LE(10, 10);
		expect(detectSupportedImageMimeType(badOffset)).toBeNull();
		expect(detectSupportedImageMimeType(Buffer.from("BMP file", "ascii"))).toBeNull();
	});

	it("returns null for text content", () => {
		expect(detectSupportedImageMimeType(Buffer.from("hello world", "utf-8"))).toBeNull();
	});
});

describe("exif orientation", () => {
	it("reads the orientation tag from a JPEG APP1 segment", () => {
		expect(getExifOrientation(makeJpegExifBytes(1))).toBe(1);
		expect(getExifOrientation(makeJpegExifBytes(6))).toBe(6);
		expect(getExifOrientation(makeJpegExifBytes(8))).toBe(8);
	});

	it("defaults to 1 for bytes without EXIF", () => {
		expect(getExifOrientation(Buffer.from([0xff, 0xd8, 0xff, 0xdb]))).toBe(1);
		expect(getExifOrientation(Buffer.from("not an image", "ascii"))).toBe(1);
	});

	it("rotates pixels for orientation 6 and flips for orientation 3", () => {
		const photon = requirePhoton();
		const red = [255, 0, 0, 255];
		const blue = [0, 0, 255, 255];

		const rotatedSource = new photon.PhotonImage(new Uint8Array([...red, ...blue]), 2, 1);
		const rotated = applyExifOrientation(photon, rotatedSource, makeJpegExifBytes(6));
		expect(rotated.get_width()).toBe(1);
		expect(rotated.get_height()).toBe(2);
		expect([...rotated.get_raw_pixels()]).toEqual([...red, ...blue]);
		rotated.free();
		if (rotated !== rotatedSource) rotatedSource.free();

		const flippedSource = new photon.PhotonImage(new Uint8Array([...red, ...blue]), 2, 1);
		const flipped = applyExifOrientation(photon, flippedSource, makeJpegExifBytes(3));
		expect(flipped).toBe(flippedSource);
		expect([...flipped.get_raw_pixels()]).toEqual([...blue, ...red]);
		flipped.free();
	});
});

describe("image processing with photon", () => {
	it("converts BMP bytes to PNG", () => {
		const pngBytes = convertImageBytesToPng(makeBmp(2, 2));
		expect(pngBytes).not.toBeNull();
		expect(detectSupportedImageMimeType(pngBytes ?? new Uint8Array())).toBe("image/png");
	});

	it("keeps small images unresized", () => {
		const pngBytes = makePngBytes(10, 10);
		const resized = resizeImageInProcess(pngBytes, "image/png");
		expect(resized).toMatchObject({
			mimeType: "image/png",
			originalWidth: 10,
			originalHeight: 10,
			width: 10,
			height: 10,
			wasResized: false,
		});
		expect(resized?.data).toBe(Buffer.from(pngBytes).toString("base64"));
	});

	it("resizes oversized images preserving aspect ratio", () => {
		const pngBytes = makePngBytes(3000, 2);
		const resized = resizeImageInProcess(pngBytes, "image/png");
		expect(resized).toMatchObject({ originalWidth: 3000, originalHeight: 2, width: 2000, height: 1, wasResized: true });
	});

	it("returns null when no encoding fits the byte budget", () => {
		const pngBytes = makePngBytes(10, 10);
		expect(resizeImageInProcess(pngBytes, "image/png", { maxBytes: 8 })).toBeNull();
	});

	it("returns null for undecodable bytes", () => {
		expect(convertImageBytesToPng(Buffer.from("not an image"))).toBeNull();
		expect(resizeImageInProcess(Buffer.from("not an image"), "image/png")).toBeNull();
	});

	it("resizes through the worker dispatch path", async () => {
		const pngBytes = makePngBytes(3000, 2);
		const resized = await resizeImage(pngBytes, "image/png");
		expect(resized).toMatchObject({ width: 2000, height: 1, wasResized: true });
	});

	it("processImage converts BMP to PNG with conversion metadata", async () => {
		const result = await processImage(makeBmp(2, 2), "image/bmp");
		expect(result).toMatchObject({ ok: true, mimeType: "image/png", convertedFrom: "image/bmp" });
	});

	it("processImage reports resize dimensions", async () => {
		const result = await processImage(makePngBytes(3000, 2), "image/png");
		if (!result.ok) throw new Error("Expected image processing to succeed.");
		expect(result.dimensions).toMatchObject({
			originalWidth: 3000,
			originalHeight: 2,
			width: 2000,
			height: 1,
			wasResized: true,
		});
	});

	it("processImage skips decoding when autoResize is off", async () => {
		const pngBytes = makePngBytes(10, 10);
		const result = await processImage(pngBytes, "image/png", { autoResize: false });
		expect(result).toMatchObject({ ok: true, mimeType: "image/png" });
		if (!result.ok) throw new Error("Expected image processing to succeed.");
		expect(result.dimensions).toBeUndefined();
		expect(result.data).toBe(Buffer.from(pngBytes).toString("base64"));
	});

	it("processImage fails cleanly for unconvertible formats", async () => {
		const result = await processImage(Buffer.from("not an image"), "image/tiff");
		expect(result).toEqual({ ok: false, reason: "could not be converted to a supported inline image format" });
	});
});
