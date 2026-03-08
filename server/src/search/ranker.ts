import type { ScoredMemory } from "../core/types.js";

// ── Score Normalization ─────────────────────────────────────────────────

/**
 * Normalize FTS5 BM25 rank to 0.0-1.0 range.
 * BM25 ranks are negative (more negative = better match).
 */
export function normalizeFtsScore(rank: number): number {
  const normalized = Math.min(1.0, Math.max(0.0, -rank / 20.0));
  return normalized;
}

/**
 * Normalize graph distance to a score (closer = higher).
 */
export function normalizeGraphScore(hopDistance: number): number {
  return 1.0 / (1 + hopDistance);
}

// ── Recency Boost ───────────────────────────────────────────────────────

/**
 * Apply a recency decay factor.
 * Score multiplier = max(0.5, 0.95^days_old)
 */
export function recencyBoost(createdAt: string): number {
  const created = new Date(createdAt).getTime();
  const now = Date.now();
  const daysOld = (now - created) / (1000 * 60 * 60 * 24);
  return Math.max(0.5, Math.pow(0.95, daysOld));
}

// ── Multi-Layer Boost ───────────────────────────────────────────────────

/**
 * Boost score for memories that appear in multiple layers.
 * +0.1 per extra layer.
 */
export function multiLayerBoost(layerCount: number): number {
  return (layerCount - 1) * 0.1;
}

// ── Apply All Boosts ────────────────────────────────────────────────────

export function applyBoosts(result: ScoredMemory, layerAppearances: number): ScoredMemory {
  let score = result.score;

  if (result.memory.created_at) {
    score *= recencyBoost(result.memory.created_at);
  }

  score += multiLayerBoost(layerAppearances);

  score = Math.min(1.0, Math.max(0.0, score));

  return { ...result, score };
}
