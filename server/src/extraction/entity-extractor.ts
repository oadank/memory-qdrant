import OpenAI from "openai";
import type { ExtractionResult, ExtractedEntity, ExtractedRelationship } from "../core/types.js";

// ── Entity Extraction Prompt ────────────────────────────────────────────

const ENTITY_EXTRACTION_PROMPT = `Extract entities and relationships from this memory text.

Return JSON with this exact structure:
{
  "entities": [
    {
      "name": "exact name as mentioned",
      "type": "Person|Project|Organization|Decision|Preference|Event|Tool|Location|Concept",
      "properties": { "key": "value" }
    }
  ],
  "relationships": [
    {
      "from_entity": "entity name",
      "to_entity": "entity name",
      "relationship": "WORKS_ON|DECIDED|PREFERS|KNOWS|USES|LOCATED_AT|BELONGS_TO|RELATED_TO|CREATED_BY|DEPENDS_ON",
      "properties": { "context": "brief context" }
    }
  ]
}

Rules:
- Only extract clearly stated entities, don't infer
- Use the most specific entity type possible
- Normalize person names to their full form when possible
- For preferences, use key/value format (key = category, value = preference)
- Keep properties minimal — only include what's explicitly stated
- If no entities are found, return {"entities": [], "relationships": []}`;

// ── Entity Extractor ────────────────────────────────────────────────────

export interface ExtractionConfig {
  apiKey: string;
  baseUrl?: string;
  model: string;
  enabled: boolean;
}

export class EntityExtractor {
  private client: OpenAI;
  private model: string;

  constructor(config: ExtractionConfig) {
    this.client = new OpenAI({
      apiKey: config.apiKey,
      baseURL: config.baseUrl,
    });
    this.model = config.model;
  }

  async extract(text: string): Promise<ExtractionResult> {
    if (!text || text.trim().length < 20) {
      return { entities: [], relationships: [] };
    }

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        messages: [
          { role: "system", content: ENTITY_EXTRACTION_PROMPT },
          { role: "user", content: text.slice(0, 4000) },
        ],
        temperature: 0.1,
        max_tokens: 1500,
        response_format: { type: "json_object" },
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        return { entities: [], relationships: [] };
      }

      const parsed = JSON.parse(content);
      return this.validateExtractionResult(parsed);
    } catch (error) {
      console.error(`[entity-extractor] Extraction failed: ${error}`);
      return { entities: [], relationships: [] };
    }
  }

  private validateExtractionResult(data: unknown): ExtractionResult {
    if (!data || typeof data !== "object") {
      return { entities: [], relationships: [] };
    }

    const raw = data as Record<string, unknown>;
    const entities: ExtractedEntity[] = [];
    const relationships: ExtractedRelationship[] = [];

    const validTypes = [
      "Person", "Project", "Organization", "Decision",
      "Preference", "Event", "Tool", "Location", "Concept",
    ];
    const validRels = [
      "WORKS_ON", "DECIDED", "PREFERS", "KNOWS", "USES",
      "LOCATED_AT", "BELONGS_TO", "RELATED_TO", "CREATED_BY", "DEPENDS_ON",
    ];

    if (Array.isArray(raw.entities)) {
      for (const e of raw.entities) {
        if (e && typeof e === "object" && typeof e.name === "string" && typeof e.type === "string") {
          entities.push({
            name: e.name,
            type: validTypes.includes(e.type) ? e.type : "Concept",
            properties: (typeof e.properties === "object" && e.properties !== null)
              ? Object.fromEntries(
                  Object.entries(e.properties as Record<string, unknown>).map(([k, v]) => [k, String(v)])
                )
              : {},
          });
        }
      }
    }

    if (Array.isArray(raw.relationships)) {
      for (const r of raw.relationships) {
        if (
          r &&
          typeof r === "object" &&
          typeof r.from_entity === "string" &&
          typeof r.to_entity === "string" &&
          typeof r.relationship === "string"
        ) {
          relationships.push({
            from_entity: r.from_entity,
            to_entity: r.to_entity,
            relationship: validRels.includes(r.relationship) ? r.relationship : "RELATED_TO",
            properties: (typeof r.properties === "object" && r.properties !== null)
              ? Object.fromEntries(
                  Object.entries(r.properties as Record<string, unknown>).map(([k, v]) => [k, String(v)])
                )
              : {},
          });
        }
      }
    }

    return { entities, relationships };
  }
}
