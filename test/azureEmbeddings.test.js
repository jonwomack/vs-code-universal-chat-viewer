"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  AzureEmbeddingClient,
  normalizeEndpoint
} = require("../src/azureEmbeddings");

test("normalizes an Azure OpenAI endpoint", () => {
  assert.equal(
    normalizeEndpoint("https://sample.openai.azure.com///"),
    "https://sample.openai.azure.com"
  );
  assert.throws(() => normalizeEndpoint("http://sample.test"), /HTTPS origin/);
});

test("calls the v1 embeddings endpoint with an API key", async () => {
  let request;
  const client = new AzureEmbeddingClient({
    endpoint: "https://sample.openai.azure.com",
    deployment: "embedding",
    dimensions: 256,
    apiKey: "secret",
    fetch: async (url, options) => {
      request = { url, options };
      return {
        ok: true,
        status: 200,
        json: async () => ({
          data: [
            { index: 1, embedding: [0, 1] },
            { index: 0, embedding: [1, 0] }
          ]
        })
      };
    }
  });

  assert.deepEqual(await client.embed(["first", "second"]), [[1, 0], [0, 1]]);
  assert.equal(
    request.url,
    "https://sample.openai.azure.com/openai/v1/embeddings"
  );
  assert.equal(request.options.headers["api-key"], "secret");
  assert.deepEqual(JSON.parse(request.options.body), {
    model: "embedding",
    input: ["first", "second"],
    dimensions: 256
  });
});

test("requires an API key before making an embeddings request", async () => {
  const client = new AzureEmbeddingClient({
    endpoint: "https://sample.openai.azure.com",
    deployment: "embedding",
    dimensions: 256,
    fetch: async () => {
      throw new Error("fetch should not be called");
    }
  });

  await assert.rejects(client.embed(["test"]), /API key has not been configured/);
});
