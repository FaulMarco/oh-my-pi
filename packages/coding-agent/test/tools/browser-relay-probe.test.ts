import { afterEach, describe, expect, it } from "bun:test";
import { findFreeCdpPort } from "@oh-my-pi/pi-coding-agent/tools/browser/attach";
import { pickRelayTarget, waitForRelayExtension } from "@oh-my-pi/pi-coding-agent/tools/browser/relay/probe";
import {
	type RelayServer,
	type RelayUnavailableInfo,
	startRelayServer,
} from "@oh-my-pi/pi-coding-agent/tools/browser/relay/server";

const EXTENSION_HELLO = {
	t: "hello",
	userAgent: "test",
	browserVersion: "Chrome/151.0.0.0",
	tabs: [],
	attachedTabIds: [],
} as const;

describe("waitForRelayExtension", () => {
	let relay: RelayServer | undefined;
	let fake: Bun.Server<undefined> | undefined;
	let extension: WebSocket | undefined;

	afterEach(() => {
		extension?.close();
		relay?.stop();
		fake?.stop(true);
		extension = undefined;
		relay = undefined;
		fake = undefined;
	});

	it("gives up at once when nothing is listening instead of polling the dial window", async () => {
		const port = await findFreeCdpPort();
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${port}`)).toBe("unreachable");
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("fails fast when the relay outlived the dial window without ever seeing an extension", async () => {
		const info: RelayUnavailableInfo = {
			error: "relay extension is not connected",
			extensionSeen: false,
			uptimeMs: 60_000,
		};
		fake = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json(info, { status: 503 }),
		});
		const started = performance.now();
		expect(await waitForRelayExtension(`http://127.0.0.1:${fake.port}`)).toBe("no-extension");
		expect(performance.now() - started).toBeLessThan(2_000);
	});

	it("keeps polling a young relay and reports ready once the extension handshakes", async () => {
		const port = await findFreeCdpPort();
		relay = startRelayServer({ port });
		const wait = waitForRelayExtension(`http://127.0.0.1:${port}`);
		// The relay is serving 503 (young, no extension yet) before the extension dials in.
		expect((await fetch(`http://127.0.0.1:${port}/json/version`)).status).toBe(503);
		extension = new WebSocket(`ws://127.0.0.1:${port}/ext`);
		extension.addEventListener("open", () => extension?.send(JSON.stringify(EXTENSION_HELLO)), { once: true });
		expect(await wait).toBe("ready");
	});
});

describe("pickRelayTarget", () => {
	let fake: Bun.Server<undefined> | undefined;

	afterEach(() => {
		fake?.stop(true);
		fake = undefined;
	});

	function serveList(list: unknown[]): string {
		fake = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(list) });
		return `http://127.0.0.1:${fake.port}`;
	}

	it("prefers the relay-reported foreground tab and honors an explicit matcher", async () => {
		const cdpUrl = serveList([
			{ id: "PAGEx.1", type: "page", title: "Docs", url: "https://docs.example/", active: false },
			{ id: "PAGEx.2", type: "page", title: "Mail", url: "https://mail.example/", active: true },
		]);
		expect(await pickRelayTarget(cdpUrl, { preferVisible: true })).toBe("PAGEx.2");
		expect(await pickRelayTarget(cdpUrl, { preferVisible: false })).toBe("PAGEx.1");
		expect(await pickRelayTarget(cdpUrl, { matcher: "docs" })).toBe("PAGEx.1");
		await expect(pickRelayTarget(cdpUrl, { matcher: "nope" })).rejects.toThrow("Available pages");
	});

	it("returns null for relays that predate the active flag", async () => {
		const cdpUrl = serveList([{ id: "PAGEx.1", type: "page", title: "Docs", url: "https://docs.example/" }]);
		expect(await pickRelayTarget(cdpUrl, { preferVisible: true })).toBeNull();
	});
});
