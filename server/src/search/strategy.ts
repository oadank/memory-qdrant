import type { SearchRequest } from "../core/types.js";

export type Strategy =
  | "fulltext+graph"
  | "graph+semantic"
  | "semantic+graph"
  | "semantic"
  | "fulltext"
  | "graph"
  | "all";

// ── Key Lookup Patterns ─────────────────────────────────────────────────

const KEY_LOOKUP_PATTERNS = [
  /what is .+'s/i,
  /what are .+'s/i,
  /.+'s (email|phone|address|preference|setting)/i,
  /^(get|find|show|tell me) .+'s/i,
  /^what (does|did) .+ (like|prefer|use|want)/i,
];

// ── Relationship Query Patterns ─────────────────────────────────────────

const RELATIONSHIP_PATTERNS = [
  /who (works on|knows|created|manages|uses)/i,
  /what.+(connected|related|linked|associated) (to|with)/i,
  /how (is|are) .+ (related|connected)/i,
  /relationship between/i,
  /(works on|belongs to|depends on|uses)/i,
  /what projects does/i,
  /who is involved (in|with)/i,
];

// ── Strategy Selection ──────────────────────────────────────────────────

export function selectStrategy(request: SearchRequest): Strategy {
  if (request.strategy && request.strategy !== "auto") {
    switch (request.strategy) {
      case "semantic": return "semantic";
      case "fulltext": return "fulltext";
      case "graph": return "graph";
      case "all": return "all";
      default: break;
    }
  }

  const query = request.query.toLowerCase();

  if (isKeyLookup(query)) return "fulltext+graph";
  if (isRelationshipQuery(query)) return "graph+semantic";

  return "semantic+graph";
}

function isKeyLookup(query: string): boolean {
  return KEY_LOOKUP_PATTERNS.some((pattern) => pattern.test(query));
}

function isRelationshipQuery(query: string): boolean {
  return RELATIONSHIP_PATTERNS.some((pattern) => pattern.test(query));
}
