import { createRequire } from "node:module";
import type * as photonNode from "@silvia-odwyer/photon-node";

/**
 * Lazy loader for @silvia-odwyer/photon-node.
 *
 * Requiring photon synchronously compiles a multi-megabyte WASM asset, so the
 * module must not load at import time of the runtime. The package is
 * CJS, which lets a deferred createRequire call stay synchronous while keeping
 * the load lazy; a missing or broken WASM asset then degrades image reads
 * instead of crashing the CLI at startup.
 */

export type PhotonModule = typeof photonNode;
export type PhotonImage = photonNode.PhotonImage;

const requirePhoton = createRequire(import.meta.url);

let cachedPhoton: PhotonModule | null | undefined;

/** Load photon, or return null when the module or its WASM is unavailable. */
export function loadPhoton(): PhotonModule | null {
	if (cachedPhoton !== undefined) {
		return cachedPhoton;
	}
	try {
		cachedPhoton = requirePhoton("@silvia-odwyer/photon-node") as PhotonModule;
	} catch {
		cachedPhoton = null;
	}
	return cachedPhoton;
}
