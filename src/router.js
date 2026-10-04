"use strict";

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "do",
  "for", "from", "how", "i", "in", "is", "it", "my", "of", "on", "or",
  "please", "the", "this", "to", "we", "what", "with", "you"
]);

function terms(value) {
  return [...new Set(
    String(value || "")
      .toLocaleLowerCase()
      .match(/[\p{L}\p{N}][\p{L}\p{N}._-]*/gu) || []
  )].filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

function rankSessions(prompt, sessions, now = Date.now()) {
  const queryTerms = terms(prompt);
  const prepared = sessions.map((session) => ({
    session,
    titleTerms: new Set(terms(session.title)),
    conversationTerms: new Set(session.searchableTerms || terms(
      `${session.title || ""}\n${session.searchableText || ""}`
    ))
  }));
  const documentFrequency = new Map();
  for (const { conversationTerms } of prepared) {
    for (const term of queryTerms) {
      if (conversationTerms.has(term)) {
        documentFrequency.set(term, (documentFrequency.get(term) || 0) + 1);
      }
    }
  }

  return prepared.map(({ session, titleTerms, conversationTerms }) => {
    const matchedTerms = queryTerms.filter((term) => conversationTerms.has(term));
    const titleMatches = matchedTerms.filter((term) => titleTerms.has(term));
    const ageDays = Math.max(0, (now - session.modifiedAt) / 86_400_000);
    const recencyScore = Math.max(0, 8 - Math.log2(ageDays + 1));
    const relevanceTermScore = matchedTerms.reduce((score, term) =>
      score + Math.log((sessions.length + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1,
    0);
    const titleScore = titleMatches.reduce((score, term) =>
      score + Math.log((sessions.length + 1) / ((documentFrequency.get(term) || 0) + 1)) + 1,
    0);
    const score = relevanceTermScore * 10
      + titleScore * 20
      + recencyScore;
    return { session, score, matchedTerms, titleMatches };
  }).sort((left, right) =>
    right.score - left.score || right.session.modifiedAt - left.session.modifiedAt
  );
}

function chooseAutomatically(ranked, enabled) {
  if (!enabled || ranked.length === 0) {
    return undefined;
  }
  return { session: ranked[0].session };
}

function rankSessionsByEmbedding(queryVector, sessions, now = Date.now()) {
  return sessions
    .filter((session) => Array.isArray(session.embeddingVectors))
    .map((session) => {
      const similarities = session.embeddingVectors
        .map((vector) => cosineSimilarity(queryVector, vector))
        .sort((left, right) => right - left);
      const strongest = similarities[0] || -1;
      const supporting = similarities.slice(0, 3);
      const supportingAverage = supporting.length
        ? supporting.reduce((sum, value) => sum + value, 0) / supporting.length
        : -1;
      const ageDays = Math.max(0, (now - session.modifiedAt) / 86_400_000);
      const recencyScore = Math.max(0, 0.01 - Math.log2(ageDays + 1) / 1000);
      return {
        session,
        score: strongest * 0.8 + supportingAverage * 0.2 + recencyScore,
        semanticScore: strongest
      };
    })
    .sort((left, right) =>
      right.score - left.score || right.session.modifiedAt - left.session.modifiedAt
    );
}

function cosineSimilarity(left, right) {
  if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
    return -1;
  }
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index];
    leftMagnitude += left[index] ** 2;
    rightMagnitude += right[index] ** 2;
  }
  if (!leftMagnitude || !rightMagnitude) {
    return -1;
  }
  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

module.exports = {
  chooseAutomatically,
  cosineSimilarity,
  rankSessions,
  rankSessionsByEmbedding,
  terms
};
