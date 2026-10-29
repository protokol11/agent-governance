// logic.ts — pure wiring for the RLCD local sidecar classifier.
//
// The sidecar (finetune-lab `src/serve/rlcd_sidecar.py`) speaks the System One
// wire protocol, so the extension reuses pi-ai's `classifySystemOne` and only
// owns the transport: base URL, request envelope, and response unwrapping.
// No pi runtime or network here, so the headless test can cover it.
import type { SystemOneTransport } from "@earendil-works/pi-ai/api/system-one-shared";
import { isRecord } from "@earendil-works/pi-ai/api/system-one-shared";

export const DEFAULT_SIDECAR_URL = "http://127.0.0.1:8931";
export const CLASSIFIER_API = "rlcd-system-one";
export const CLASSIFIER_MODEL_ID = "cell-coder-1.5b";

/** Trim a configured sidecar URL and strip trailing slashes; default when unset. */
export function resolveSidecarUrl(env: Record<string, string | undefined> = process.env): string {
	const raw = env.RLCD_SIDECAR_URL?.trim();
	const url = raw && raw.length > 0 ? raw : DEFAULT_SIDECAR_URL;
	return url.replace(/\/+$/u, "");
}

/** pi's System One transport always POSTs to `<baseUrl>/systemone`. */
export function systemOneUrl(baseUrl: string): URL {
	return new URL("systemone", `${baseUrl.replace(/\/+$/u, "")}/`);
}

/** System One request envelope: the service's model id plus state/questions. */
export function systemOnePayload(
	modelId: string,
	request: { state: unknown; questions: Record<string, unknown> },
): unknown {
	return { model: modelId, ...request };
}

/** Unwrap the sidecar response `{ answers, usage }`; reject anything else. */
export function systemOneOutput(body: unknown): Record<string, unknown> {
	if (!isRecord(body)) throw new Error("RLCD sidecar returned an unexpected response");
	return body;
}

export function createTransport(baseUrl: string): SystemOneTransport {
	return {
		api: CLASSIFIER_API,
		label: "RLCD sidecar",
		url: (model) => systemOneUrl(model.baseUrl || baseUrl),
		payload: (model, request) => systemOnePayload(model.id, request),
		output: systemOneOutput,
	};
}
