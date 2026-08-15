/** Small text helpers shared by the arXiv and ar5iv parsers. */

export function decodeXmlEntities(text: string): string {
	return text
		.replace(/&#x([0-9a-fA-F]+);/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_match, dec: string) => String.fromCodePoint(Number.parseInt(dec, 10)))
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&amp;/g, "&");
}

export function normalizeWhitespace(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

export function stripHtmlTags(html: string): string {
	return normalizeWhitespace(decodeXmlEntities(html.replace(/<[^>]+>/g, " ")));
}

/** Title comparison key, mirroring pasa's keep_letters but keeping digits. */
export function normalizeTitle(title: string): string {
	return title.toLowerCase().replace(/[^a-z0-9]/g, "");
}
