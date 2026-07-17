import type {
	Api,
	AssistantMessage,
	Context,
	Model,
	SimpleStreamOptions,
} from "@earendil-works/pi-ai";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

type SummaryAuth = {
	apiKey?: string;
	headers?: Record<string, string>;
	env?: Record<string, string>;
};

type CompleteSummaryRequest = {
	ctx: Pick<ExtensionContext, "modelRegistry">;
	model: Model<Api>;
	context: Context;
	auth: SummaryAuth;
	signal?: AbortSignal;
};

// Pi's compatibility completion helpers dispatch through pi-ai's global API
// registry. Extension providers registered with pi.registerProvider() live in
// coding-agent's ModelRuntime instead, so custom APIs (for example
// sap-aicore-orchestration) are not visible to completeSimple(). Prefer the
// provider's registered streamSimple implementation when it owns this model's
// API, then retain the compatibility path for built-in providers.
export function completeSummary({
	ctx,
	model,
	context,
	auth,
	signal,
}: CompleteSummaryRequest): Promise<AssistantMessage> {
	if (!auth.apiKey) throw new Error("Summary auth is missing an API key");

	const options: SimpleStreamOptions = {
		apiKey: auth.apiKey,
		headers: auth.headers,
		env: auth.env,
		maxTokens: 8192,
		signal,
	};
	const provider = ctx.modelRegistry.getRegisteredProviderConfig(model.provider);
	if (provider?.streamSimple && provider.api === model.api) {
		return provider.streamSimple(model, context, options).result();
	}

	return completeSimple(model, context, options);
}
