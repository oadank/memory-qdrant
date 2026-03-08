import OpenAI from "openai";

// ── Summarization Prompt ────────────────────────────────────────────────

const SUMMARIZE_PROMPT = `Summarize this conversation into 5-10 concise bullet points.
Focus on:
- Decisions made
- Tasks discussed or assigned
- Preferences expressed
- Important facts learned
- Action items or next steps

Be specific. Use names and details. Skip pleasantries and meta-conversation.
Return the summary as a plain text bulleted list.`;

// ── Conversation Summarizer ─────────────────────────────────────────────

export interface SummarizerConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
}

export class ConversationSummarizer {
  private client: OpenAI;
  private model: string;

  constructor(config: SummarizerConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
  }

  async summarize(
    messages: Array<{ role: string; content: string; timestamp?: string }>
  ): Promise<string | null> {
    if (messages.length === 0) return null;

    const transcript = messages
      .map((m) => {
        const prefix = m.role === "user" ? "User" : m.role === "assistant" ? "Assistant" : "System";
        return `${prefix}: ${m.content}`;
      })
      .join("\n");

    const truncated = transcript.slice(-6000);

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: SUMMARIZE_PROMPT },
          { role: "user", content: truncated },
        ],
        temperature: 0.2,
        max_tokens: 500,
      });

      const content = response.choices[0]?.message?.content?.trim();
      return content || null;
    } catch (error) {
      console.error(`[summarizer] Summarization failed: ${error}`);
      return null;
    }
  }
}
