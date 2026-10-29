// test-logic.ts — headless check of the RLCD sidecar transport.
//
// Serves a canned System One response on a loopback port and drives the exact
// `classifySystemOne` + `createTransport` path the extension uses. No model, no
// sidecar, no LLM call.
//
//   node --experimental-strip-types test-logic.ts
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { ClassifierApi, ClassifierModel } from "@earendil-works/pi-ai";
import { classifySystemOne } from "@earendil-works/pi-ai/api/system-one-shared";
import {
	CLASSIFIER_API,
	createTransport,
	DEFAULT_SIDECAR_URL,
	resolveSidecarUrl,
	systemOneOutput,
	systemOnePayload,
	systemOneUrl,
} from "./logic.ts";

let received: { url?: string; body: Record<string, unknown> } = { body: {} };
const server = createServer((req, res) => {
	let raw = "";
	req.on("data", (chunk) => {
		raw += chunk;
	});
	req.on("end", () => {
		received = { url: req.url, body: JSON.parse(raw) as Record<string, unknown> };
		res.setHeader("content-type", "application/json");
		res.end(
			JSON.stringify({
				answers: { q: { type: "noul", noul: 0.7 } },
				usage: { input_tokens: 5, output_tokens: 1 },
			}),
		);
	});
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const baseUrl = `http://127.0.0.1:${address.port}`;

// ── pure helpers ──────────────────────────────────────────────────────────
assert.equal(systemOneUrl(baseUrl).toString(), `${baseUrl}/systemone`);
assert.equal(resolveSidecarUrl({}), DEFAULT_SIDECAR_URL);
assert.equal(resolveSidecarUrl({ RLCD_SIDECAR_URL: " http://example:1/ " }), "http://example:1");
assert.deepEqual(systemOnePayload("m", { state: {}, questions: {} }), { model: "m", state: {}, questions: {} });
assert.throws(() => systemOneOutput(null), /unexpected response/);

// ── one classify call through the real transport ──────────────────────────
const model = {
	type: "classifier",
	api: CLASSIFIER_API,
	id: "cell-coder-1.5b",
	provider: "rlcd-local",
	baseUrl,
	name: "test",
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 4096,
} as unknown as ClassifierModel<ClassifierApi>;

const result = await classifySystemOne(
	createTransport(baseUrl),
	model,
	{
		state: { diff: "x", cp_texts: { "CP-01": "text" } },
		questions: {
			q: { type: "bool", instructions: "Violation?", criteria: { true: "yes", false: "no" } },
		},
	},
	{ apiKey: "local" },
);

assert.equal(received.url, "/systemone", "transport must POST to /systemone");
assert.equal(received.body.model, "cell-coder-1.5b");
assert.equal(
	(received.body.questions as Record<string, { type: string }>).q.type,
	"noul",
	"bool question must map to noul on the wire",
);
assert.equal(result.stopReason, "stop");
const answer = result.answers.q;
assert.ok(answer?.type === "bool", "answer must be a bool");
assert.ok(answer.type === "bool" && Math.abs(answer.probability - 0.7) < 1e-9);
assert.equal(result.usage?.input, 5);
assert.equal(result.usage?.output, 1);

server.close();

// ── the extension registers the provider + classifier ─────────────────────
const { default: rlcdLocal } = await import("./index.ts");
let registered: { name: string; config: Record<string, unknown> } = { name: "", config: {} };
const mockPi = {
	registerProvider: (name: string, config: Record<string, unknown>) => {
		registered = { name, config };
	},
};
rlcdLocal(mockPi as never);
assert.equal(registered.name, "rlcd-local");
const models = registered.config.models as Array<{ id: string; type: string; api: string }>;
assert.equal(models?.[0]?.id, "cell-coder-1.5b");
assert.equal(models?.[0]?.type, "classifier");
assert.ok((registered.config.classifiers as Record<string, unknown>)[CLASSIFIER_API]);

console.log("HANDLER OK — /systemone, bool→noul, probability 0.7, usage 5/1, provider registered");
