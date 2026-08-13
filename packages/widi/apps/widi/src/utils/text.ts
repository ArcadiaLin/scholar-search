const utf8Encoder = new TextEncoder();

/** Number of bytes needed to encode a string as UTF-8. */
export function utf8ByteLength(value: string): number {
	return utf8Encoder.encode(value).byteLength;
}
