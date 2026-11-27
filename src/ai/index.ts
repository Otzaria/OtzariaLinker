/*
 * The optional AI review layer (docs/AI_INTEGRATION.md). Pure: no network, no DOM, no Preact. No layer of the app imports
 * it, so none of it is in the single HTML file; a host with network access (a CLI, a plugin host) implements AiProvider.
 */
export * from "./types";
export { checkAiConfig, consentCovers, secretFields, AI_LIMIT_CAPS, MAX_SKILLS, MAX_SKILL_CHARS, type AiConfigCheck } from "./config";
export { AI_ANSWER_SCHEMA, buildRequest, buildSystemPrompt, estimateTokens, prepareCandidates, batchCandidates, snippet, userMessage, type PreparedCandidate } from "./request";
export { validateAiAnswer, MAX_REASON_CHARS, type AnswerCheck } from "./validate";
export { runAiReview, redactSecrets, type AiRunInput } from "./runner";
export { MockAiProvider, acceptEngineChoice, type MockProviderOptions, type MockResponder } from "./mock-provider";
