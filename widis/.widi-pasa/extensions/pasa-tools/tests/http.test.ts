/**
 * Retry, timeout and status handling, driven against a local server rather
 * than a live API: the behaviour under 429 and under a hung connection is
 * exactly what cannot be observed reliably against the real one.
 */

import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, describe, it } from "node:test";
import { HttpStatusError, httpText } from "../core/http.ts";

type Handler = (attempt: number) => { status: number; body?: string; hang?: boolean };

let attempts = 0;
let handler: Handler = () => ({ status: 200, body: "ok" });

const server: Server = createServer((_request, response) => {
	attempts += 1;
	const result = handler(attempts);
	if (result.hang) return; // never answers; the client timeout must fire
	response.writeHead(result.status, { "Content-Type": "text/plain" });
	response.end(result.body ?? "");
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

after(() => server.close());

function arrange(next: Handler) {
	attempts = 0;
	handler = next;
}

describe("httpText", () => {
	it("returns the body on success without retrying", async () => {
		arrange(() => ({ status: 200, body: "hello" }));
		assert.equal(await httpText(base), "hello");
		assert.equal(attempts, 1);
	});

	it("retries a rate limit and succeeds", async () => {
		arrange((attempt) => (attempt < 3 ? { status: 429 } : { status: 200, body: "recovered" }));
		assert.equal(await httpText(base, { retries: 2 }), "recovered");
		assert.equal(attempts, 3);
	});

	it("gives up after the bounded number of retries and stays observable", async () => {
		arrange(() => ({ status: 503 }));
		await assert.rejects(httpText(base, { retries: 2 }), (error: unknown) => {
			assert.ok(error instanceof HttpStatusError);
			assert.equal(error.status, 503);
			return true;
		});
		assert.equal(attempts, 3, "retries are bounded, not unlimited");
	});

	it("does not retry a status that will never succeed", async () => {
		arrange(() => ({ status: 404 }));
		await assert.rejects(httpText(base, { retries: 3 }), (error: unknown) => {
			assert.ok(error instanceof HttpStatusError);
			assert.equal(error.status, 404);
			return true;
		});
		assert.equal(attempts, 1);
	});

	it("times out a request the server never answers", async () => {
		arrange(() => ({ status: 200, hang: true }));
		await assert.rejects(httpText(base, { timeoutMs: 150, retries: 0 }));
	});

	it("stops immediately when the caller aborts", async () => {
		arrange(() => ({ status: 503 }));
		const controller = new AbortController();
		const pending = httpText(base, { retries: 5, signal: controller.signal });
		controller.abort();
		await assert.rejects(pending);
		assert.ok(attempts <= 1, `aborting must not keep retrying, saw ${attempts} attempts`);
	});
});
