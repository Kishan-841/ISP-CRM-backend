import { genAI, NEXUS_MODEL } from '../config/gemini.js';

/**
 * Generate an answer from Gemini given a system prompt and user message.
 * history: [{ role: 'user' | 'model', content: string }]
 */
export const generateAnswer = async ({ systemPrompt, userMessage, history = [] }) => {
  const contents = [
    ...history.map((h) => ({ role: h.role, parts: [{ text: h.content }] })),
    { role: 'user', parts: [{ text: userMessage }] },
  ];

  const response = await genAI.models.generateContent({
    model: NEXUS_MODEL,
    contents,
    config: {
      systemInstruction: systemPrompt,
      temperature: 0.2,
      maxOutputTokens: 800,
    },
  });

  return {
    text: response.text ?? '',
    tokensUsed: response.usageMetadata?.totalTokenCount ?? null,
  };
};
