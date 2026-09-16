import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describeModelConfig,
  isAnthropicModel,
  modelRequestFields,
  modelsForTier,
  parseModelList,
  resolveModel,
} from "../services/models";

const MODEL_ENV_KEYS = ["ONYX_MODEL", "ONYX_MODEL_LIGHT", "CLAUDE_MODEL", "CLAUDE_MODEL_LIGHT"];
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = {};
  for (const key of MODEL_ENV_KEYS) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of MODEL_ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

describe("resolveModel()", () => {
  it("returns the heavy default for the heavy tier", () => {
    expect(resolveModel("heavy")).toBe("anthropic/claude-sonnet-4.6");
  });

  it("returns the light default for the light tier", () => {
    expect(resolveModel("light")).toBe("anthropic/claude-haiku-4.5");
  });

  it("prefers ONYX_MODEL over the legacy CLAUDE_MODEL", () => {
    process.env.ONYX_MODEL = "openai/gpt-5";
    process.env.CLAUDE_MODEL = "anthropic/claude-opus-5";
    expect(resolveModel("heavy")).toBe("openai/gpt-5");
  });

  it("still honours the legacy CLAUDE_MODEL / CLAUDE_MODEL_LIGHT names", () => {
    process.env.CLAUDE_MODEL = "anthropic/claude-opus-5";
    process.env.CLAUDE_MODEL_LIGHT = "anthropic/claude-haiku-4.5";
    expect(resolveModel("heavy")).toBe("anthropic/claude-opus-5");
    expect(resolveModel("light")).toBe("anthropic/claude-haiku-4.5");
  });

  it("treats a blank ONYX_MODEL as unset (empty .env values are common)", () => {
    process.env.ONYX_MODEL = "   ";
    process.env.CLAUDE_MODEL = "anthropic/claude-opus-5";
    expect(resolveModel("heavy")).toBe("anthropic/claude-opus-5");
  });

  it("returns the first entry of a comma-separated list", () => {
    process.env.ONYX_MODEL = "a/one:free, b/two:free";
    expect(resolveModel("heavy")).toBe("a/one:free");
  });
});

describe("parseModelList()", () => {
  it("trims entries and drops blanks and duplicates", () => {
    expect(parseModelList(" a/x , ,b/y,a/x ")).toEqual(["a/x", "b/y"]);
  });

  it("returns an empty list for an empty string", () => {
    expect(parseModelList("")).toEqual([]);
  });
});

describe("modelRequestFields()", () => {
  it("sends only `model` when a single model is configured", () => {
    process.env.ONYX_MODEL = "a/one";
    expect(modelRequestFields("heavy")).toEqual({ model: "a/one" });
  });

  it("adds the OpenRouter `models` fallback array for a list", () => {
    process.env.ONYX_MODEL_LIGHT = "a/one:free,b/two:free,openrouter/free";
    expect(modelRequestFields("light")).toEqual({
      model: "a/one:free",
      models: ["a/one:free", "b/two:free", "openrouter/free"],
    });
  });

  it("keeps tiers independent", () => {
    process.env.ONYX_MODEL = "a/one,b/two";
    expect(modelsForTier("light")).toEqual(["anthropic/claude-haiku-4.5"]);
  });
});

describe("isAnthropicModel() / describeModelConfig()", () => {
  it("detects Anthropic ids by provider prefix", () => {
    expect(isAnthropicModel("anthropic/claude-sonnet-4.6")).toBe(true);
    expect(isAnthropicModel("cohere/north-mini-code:free")).toBe(false);
  });

  it("mentions prompt caching only when an Anthropic model is configured", () => {
    expect(describeModelConfig()).toContain("prompt caching");
    process.env.ONYX_MODEL = "cohere/north-mini-code:free,openrouter/free";
    process.env.ONYX_MODEL_LIGHT = "openrouter/free";
    const line = describeModelConfig();
    expect(line).toContain("heavy: cohere/north-mini-code:free -> openrouter/free");
    expect(line).not.toContain("prompt caching");
  });
});

describe("OpenRouter fallback limit", () => {
  it("caps the models array at three, keeping the configured order", () => {
    process.env.ONYX_MODEL = "a/1,b/2,c/3,d/4";
    expect(modelRequestFields("heavy")).toEqual({
      model: "a/1",
      models: ["a/1", "b/2", "c/3"],
    });
  });

  it("names the dropped models in the startup line", () => {
    process.env.ONYX_MODEL = "a/1,b/2,c/3,d/4";
    const line = describeModelConfig();
    expect(line).toContain("ignored");
    expect(line).toContain("d/4");
    expect(line).not.toContain("a/1 -> b/2 -> c/3 -> d/4");
  });

  it("says nothing about dropped models when the list fits", () => {
    process.env.ONYX_MODEL = "a/1,b/2";
    expect(describeModelConfig()).not.toContain("ignored");
  });
});
