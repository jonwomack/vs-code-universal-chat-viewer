"use strict";

class AzureEmbeddingClient {
  constructor(options) {
    this.endpoint = normalizeEndpoint(options.endpoint);
    this.deployment = options.deployment;
    this.dimensions = options.dimensions;
    this.apiKey = options.apiKey;
    this.fetch = options.fetch || globalThis.fetch;
  }

  get signature() {
    return [
      "azure-openai-v1",
      this.endpoint,
      this.deployment,
      this.dimensions
    ].join("|");
  }

  async embed(inputs) {
    if (!Array.isArray(inputs) || inputs.length === 0) {
      return [];
    }
    if (typeof this.fetch !== "function") {
      throw new Error("this Node.js runtime does not provide fetch");
    }
    if (!this.apiKey) {
      throw new Error("an Azure OpenAI API key has not been configured");
    }

    const response = await fetchWithRetry(
      this.fetch,
      `${this.endpoint}/openai/v1/embeddings`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "api-key": this.apiKey
        },
        body: JSON.stringify({
          model: this.deployment,
          input: inputs,
          dimensions: this.dimensions
        })
      }
    );
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Azure embeddings request failed (${response.status}): ${detail}`);
    }

    const payload = await response.json();
    const ordered = [...(payload.data || [])].sort(
      (left, right) => left.index - right.index
    );
    if (
      ordered.length !== inputs.length
      || ordered.some((item) => !Array.isArray(item.embedding))
    ) {
      throw new Error("Azure embeddings response did not contain every requested vector");
    }
    return ordered.map((item) => item.embedding);
  }
}

async function fetchWithRetry(fetchImplementation, url, options, attempts = 4) {
  let response;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    response = await fetchImplementation(url, {
      ...options,
      signal: AbortSignal.timeout(60_000)
    });
    if (![429, 502, 503, 504].includes(response.status) || attempt === attempts - 1) {
      return response;
    }
    const retryAfter = Number(response.headers.get("retry-after"));
    const delay = Number.isFinite(retryAfter)
      ? retryAfter * 1000
      : Math.min(1000 * (2 ** attempt), 8000);
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
  return response;
}

function normalizeEndpoint(value) {
  const endpoint = String(value || "").trim().replace(/\/+$/, "");
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(endpoint)) {
    throw new Error("Azure OpenAI endpoint must be an HTTPS origin");
  }
  return endpoint;
}

module.exports = {
  AzureEmbeddingClient,
  fetchWithRetry,
  normalizeEndpoint
};
