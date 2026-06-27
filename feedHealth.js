function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function toNumber(value, fallback = 0) {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * Aggregates page/post analysis into a single feed health score.
 * Higher score means healthier feed.
 *
 * Expected input item fields:
 * - toxicityScore: 0..100
 * - negativityScore: 0..100 (optional)
 * - negativeWordCount + wordCount (optional fallback for negativity)
 * - isToxic: boolean (optional; default: toxicityScore >= 60)
 */
export function generateFeedHealthScore(items = []) {
  const rows = Array.isArray(items) ? items : [];
  const totalPosts = rows.length;

  if (totalPosts === 0) {
    return {
      totalPosts: 0,
      averageToxicity: 0,
      averageNegativity: 0,
      toxicPostFrequency: 0,
      feedHealthScore: 100,
    };
  }

  let toxicitySum = 0;
  let negativitySum = 0;
  let toxicPosts = 0;

  for (const row of rows) {
    const toxicity = clamp(toNumber(row?.toxicityScore, 0), 0, 100);

    let negativity = toNumber(row?.negativityScore, NaN);
    if (!Number.isFinite(negativity)) {
      const negativeWordCount = toNumber(row?.negativeWordCount, 0);
      const wordCount = Math.max(1, toNumber(row?.wordCount, 0));
      negativity = clamp((negativeWordCount / wordCount) * 100, 0, 100);
    } else {
      negativity = clamp(negativity, 0, 100);
    }

    const isToxic = typeof row?.isToxic === 'boolean' ? row.isToxic : toxicity >= 60;

    toxicitySum += toxicity;
    negativitySum += negativity;
    if (isToxic) {
      toxicPosts += 1;
    }
  }

  const averageToxicity = toxicitySum / totalPosts;
  const averageNegativity = negativitySum / totalPosts;
  const toxicPostFrequency = (toxicPosts / totalPosts) * 100;

  // Risk model weights:
  // toxicity 50%, negativity 25%, frequency of toxic posts 25%
  const riskScore = averageToxicity * 0.5 + averageNegativity * 0.25 + toxicPostFrequency * 0.25;
  const feedHealthScore = clamp(Math.round(100 - riskScore), 0, 100);

  return {
    totalPosts,
    averageToxicity: round2(averageToxicity),
    averageNegativity: round2(averageNegativity),
    toxicPostFrequency: round2(toxicPostFrequency),
    feedHealthScore,
  };
}

export default generateFeedHealthScore;
