// rlcd-local — register the local RLCD sidecar as a pi classifier.
//
// S1 serving path for the finetune-lab decision cell: the RLCD head (a logistic
// head over the frozen representation's hidden state) runs in a local Python
// service (`finetune-lab/src/serve/rlcd_sidecar.py`) and answers System One
// requests. This extension exposes it as `rlcd-local/cell-coder-1.5b`, callable
// from extensions through `ctx.modelRegistry.classify()`.
//
// Start the sidecar first (WSL, lab venv, GPU):
//   HF_HOME=~/.cache/hf python src/serve/rlcd_sidecar.py --serve --host 0.0.0.0 --port 8931
// Override its URL with RLCD_SIDECAR_URL.
//
// Serving is narrow: the head was trained on state `{diff, cp_texts}` and one
// `noul` question with criteria `["yes", "no"]`. Other question shapes shift the
// prompt representation and degrade the probability.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { classifySystemOne } from "@earendil-works/pi-ai/api/system-one-shared";
import {
	CLASSIFIER_API,
	CLASSIFIER_MODEL_ID,
	createTransport,
	resolveSidecarUrl,
} from "./logic.ts";

const PROVIDER_ID = "rlcd-local";

export default function rlcdLocal(pi: ExtensionAPI): void {
	const baseUrl = resolveSidecarUrl();
	const transport = createTransport(baseUrl);

	pi.registerProvider(PROVIDER_ID, {
		name: "RLCD local sidecar",
		baseUrl,
		apiKey: "local",
		models: [
			{
				type: "classifier",
				id: CLASSIFIER_MODEL_ID,
				name: "RLCD cell (Coder-1.5B, cp-review)",
				api: CLASSIFIER_API,
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 4096,
			},
		],
		classifiers: {
			[CLASSIFIER_API]: {
				classify: (model, context, options) =>
					classifySystemOne(transport, model, context, {
						...options,
						apiKey: options?.apiKey ?? "local",
					}),
			},
		},
	});
}
