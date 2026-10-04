"use strict";

function classifyAppendedChatActivity(text, latestRequestIndex = -1) {
  let relevant = false;
  let response = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    try {
      const record = JSON.parse(line);
      const root = Array.isArray(record.k) ? record.k[0] : undefined;
      if (root === "pendingRequests") {
        relevant = true;
        continue;
      }
      if (root !== "requests") {
        continue;
      }
      const requestIndex = Number(record.k[1]);
      if (
        record.k.length === 1
        || (
          Number.isInteger(requestIndex)
          && requestIndex >= latestRequestIndex
        )
      ) {
        relevant = true;
        response ||= record.k[2] === "response";
      }
    } catch {
      // An incomplete JSONL append is not evidence of response activity.
    }
  }
  return { relevant, response };
}

function appendedChatActivity(text, latestRequestIndex) {
  return classifyAppendedChatActivity(text, latestRequestIndex).relevant;
}

function chatIsInProgress(data) {
  if (Array.isArray(data?.pendingRequests) && data.pendingRequests.length > 0) {
    return true;
  }
  const requests = Array.isArray(data?.requests) ? data.requests : [];
  const latest = requests.at(-1);
  return Boolean(
    latest
    && latest.result === undefined
    && Array.isArray(latest.response)
    && latest.response.length > 0
  );
}

module.exports = {
  appendedChatActivity,
  classifyAppendedChatActivity,
  chatIsInProgress
};
