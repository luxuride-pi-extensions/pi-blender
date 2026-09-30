import { inflateSync } from "node:zlib";

/**
 * A minimal PNG reader: 8- and 16-bit, greyscale / RGB / palette, with tRNS.
 *
 * The only image this extension produces is a render, and a render is a PNG
 * written by Blender's own encoder. Pulling in an image library for that would
 * put a dependency between "the critic can count pixels" and an npm install,
 * so the subset that Blender emits is decoded here instead.
 *
 * Interlaced and JPEG/WebP inputs are refused by name rather than decoded
 * wrongly: a half-decoded image would report confident numbers for garbage.
 */

export interface DecodedImage {
	width: number;
	height: number;
	/** 4 bytes per pixel, RGBA, row-major, straight (non-premultiplied) alpha. */
	pixels: Buffer;
	bitDepth: number;
	colorType: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CHANNELS_BY_COLOR_TYPE: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** 0 = nothing, 1 = palette, 2 = truecolour, 3 = indexed, 4 = grey+alpha, 6 = RGBA. */
const ALPHA_BY_COLOR_TYPE: Record<number, boolean> = { 0: false, 2: false, 3: true, 4: true, 6: true };

export function looksLikePng(buffer: Buffer): boolean {
	return buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE);
}

function paethPredictor(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

function unfilter(raw: Buffer, width: number, height: number, bytesPerPixel: number): Buffer {
	const stride = width * bytesPerPixel;
	const out = Buffer.alloc(stride * height);
	let source = 0;
	for (let row = 0; row < height; row++) {
		const filter = raw[source++];
		const line = raw.subarray(source, source + stride);
		source += stride;
		const target = out.subarray(row * stride, row * stride + stride);
		const previous = row > 0 ? out.subarray((row - 1) * stride, row * stride) : null;
		for (let index = 0; index < stride; index++) {
			const rawByte = line[index] ?? 0;
			const left = index >= bytesPerPixel ? (target[index - bytesPerPixel] ?? 0) : 0;
			const up = previous ? (previous[index] ?? 0) : 0;
			const upLeft = previous && index >= bytesPerPixel ? (previous[index - bytesPerPixel] ?? 0) : 0;
			let value: number;
			switch (filter) {
				case 0:
					value = rawByte;
					break;
				case 1:
					value = rawByte + left;
					break;
				case 2:
					value = rawByte + up;
					break;
				case 3:
					value = rawByte + ((left + up) >> 1);
					break;
				case 4:
					value = rawByte + paethPredictor(left, up, upLeft);
					break;
				default:
					throw new Error(`PNG row ${row} uses unknown filter type ${filter}.`);
			}
			target[index] = value & 0xff;
		}
	}
	return out;
}

function sampleAt(source: Buffer, index: number, bitDepth: number): number {
	if (bitDepth === 16) return (source[index * 2] ?? 0) / 255;
	if (bitDepth === 8) return (source[index] ?? 0) / 255;
	const perByte = 8 / bitDepth;
	const byte = source[Math.floor(index / perByte)] ?? 0;
	const shift = 8 - bitDepth * ((index % perByte) + 1);
	const maxValue = (1 << bitDepth) - 1;
	return ((byte >> shift) & maxValue) / maxValue;
}

export function decodePng(buffer: Buffer): DecodedImage {
	if (!looksLikePng(buffer)) {
		throw new Error("Not a PNG file (bad signature). Renders are PNG; a .jpg or .webp reference cannot be sampled.");
	}

	let offset = 8;
	let width = 0;
	let height = 0;
	let bitDepth = 8;
	let colorType = 2;
	let interlace = 0;
	let palette: Buffer | undefined;
	let transparency: Buffer | undefined;
	let data: Buffer | undefined;

	while (offset + 8 <= buffer.length) {
		const length = buffer.readUInt32BE(offset);
		const type = buffer.toString("ascii", offset + 4, offset + 8);
		const start = offset + 8;
		const end = start + length;
		if (end > buffer.length) throw new Error(`PNG chunk "${type}" claims ${length} bytes but the file ends first.`);
		const body = buffer.subarray(start, end);

		if (type === "IHDR") {
			width = body.readUInt32BE(0);
			height = body.readUInt32BE(4);
			bitDepth = body[8] ?? 8;
			colorType = body[9] ?? 2;
			interlace = body[12] ?? 0;
		} else if (type === "PLTE") {
			palette = body;
		} else if (type === "tRNS") {
			transparency = body;
		} else if (type === "IDAT") {
			data = data ? Buffer.concat([data, body]) : Buffer.from(body);
		} else if (type === "IEND") {
			break;
		}
		offset = end + 4;
	}

	if (!width || !height) throw new Error("PNG has no IHDR chunk.");
	if (interlace !== 0) throw new Error("Interlaced PNG images are not supported; re-save the image non-interlaced.");
	if (![1, 2, 4, 8, 16].includes(bitDepth)) throw new Error(`Unsupported PNG bit depth ${bitDepth}.`);
	const channels = CHANNELS_BY_COLOR_TYPE[colorType];
	if (!channels) throw new Error(`Unsupported PNG colour type ${colorType}.`);
	if (colorType === 3 && !palette) throw new Error("Indexed PNG has no palette chunk.");
	if (!data) throw new Error("PNG has no image data.");

	// The filter's left neighbour sits `bytesPerPixel` back, where a pixel
	// occupies one byte at any depth below 16 and two at 16.
	const bytesPerPixel = channels * (bitDepth === 16 ? 2 : 1);
	const raw = unfilter(inflateSync(data), width, height, bytesPerPixel);
	const pixels = Buffer.alloc(width * height * 4);
	const hasAlpha = ALPHA_BY_COLOR_TYPE[colorType] === true;

	for (let index = 0; index < width * height; index++) {
		const base = index * 4;
		if (colorType === 3) {
			const entry = Math.round(sampleAt(raw, index, bitDepth) * 255);
			pixels[base] = palette?.[entry * 3] ?? 0;
			pixels[base + 1] = palette?.[entry * 3 + 1] ?? 0;
			pixels[base + 2] = palette?.[entry * 3 + 2] ?? 0;
			pixels[base + 3] = transparency?.[entry] ?? 255;
			continue;
		}
		const step = bitDepth === 16 ? 2 : 1;
		const source = index * channels * step;
		if (channels <= 2) {
			const grey = sampleAt(raw, source, bitDepth) * 255;
			pixels[base] = grey;
			pixels[base + 1] = grey;
			pixels[base + 2] = grey;
			pixels[base + 3] = channels === 2 ? sampleAt(raw, source + step, bitDepth) * 255 : 255;
			continue;
		}
		pixels[base] = sampleAt(raw, source, bitDepth) * 255;
		pixels[base + 1] = sampleAt(raw, source + step, bitDepth) * 255;
		pixels[base + 2] = sampleAt(raw, source + step * 2, bitDepth) * 255;
		pixels[base + 3] = hasAlpha ? sampleAt(raw, source + step * 3, bitDepth) * 255 : 255;
	}

	return { width, height, pixels, bitDepth, colorType };
}
