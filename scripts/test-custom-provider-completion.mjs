#!/usr/bin/env node

import assert from "node:assert/strict";
import {
	registerApiProvider,
	unregisterApiProviders,
} from "@earendil-works/pi-ai/compat";
import { completeSummary } from "../src/complete-summary.ts";

const model = {
	id: "test-model",
	name: "Test custom model",
	api: "test-custom-api",
	provider: "test-custom-provider",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 8_192,
};
const context = {
	messages: [
		{
			role: "user",
			content: [{ type: "text", text: "Summarize this" }],
			timestamp: Date.now(),
		},
	],
};
const expected = {
	role: "assistant",
	content: [{ type: "text", text: "Custom provider summary" }],
	api: model.api,
	provider: model.provider,
	model: model.id,
	usage: {
		input: 3,
		output: 3,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 6,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	},
	stopReason: "stop",
	timestamp: Date.now(),
};

const controller = new AbortController();
let streamCalls = 0;
const modelRegistry = {
	getRegisteredProviderConfig(provider) {
		assert.equal(provider, model.provider);
		return {
			api: model.api,
			streamSimple(receivedModel, receivedContext, options) {
				streamCalls += 1;
				assert.equal(receivedModel, model);
				assert.equal(receivedContext, context);
				assert.equal(options.apiKey, "service-key-json");
				assert.equal(options.env.AI_RESOURCE_GROUP, "test-group");
				assert.equal(options.maxTokens, 8_192);
				assert.equal(options.signal, controller.signal);
				return { result: async () => expected };
			},
		};
	},
};

const response = await completeSummary({
	ctx: { modelRegistry },
	model,
	context,
	auth: {
		apiKey: "service-key-json",
		env: { AI_RESOURCE_GROUP: "test-group" },
	},
	signal: controller.signal,
});

assert.equal(streamCalls, 1, "registered custom stream should be called once");
assert.equal(response, expected, "custom stream result should be returned");
process.stdout.write("✓ registered custom providers handle handoff completion\n");

const compatSource = "pi-handoff-regression-test";
const compatModel = {
	...model,
	api: "test-compat-api",
	provider: "test-compat-provider",
};
const compatExpected = {
	...expected,
	api: compatModel.api,
	provider: compatModel.provider,
};
let compatCalls = 0;
const compatStream = () => {
	compatCalls += 1;
	return { result: async () => compatExpected };
};

registerApiProvider(
	{
		api: compatModel.api,
		stream: compatStream,
		streamSimple: compatStream,
	},
	compatSource,
);
try {
	const compatResponse = await completeSummary({
		ctx: {
			modelRegistry: {
				getRegisteredProviderConfig: () => undefined,
			},
		},
		model: compatModel,
		context,
		auth: { apiKey: "compat-test-key" },
	});
	assert.equal(compatCalls, 1, "compatibility stream should be called once");
	assert.equal(
		compatResponse,
		compatExpected,
		"compatibility result should be returned",
	);
	process.stdout.write("✓ global API providers retain compatibility dispatch\n");
} finally {
	unregisterApiProviders(compatSource);
}
