const POSITIVE_CONVERSION_EVENTS = new Set([
  "wishlist_add",
  "watch",
  "watched",
  "rate",
  "rating",
]);

const IMPRESSION_EVENTS = new Set([
  "view",
  "detail_open",
  "open",
  "click",
]);

function scoreBucket(score) {
  if (typeof score !== "number" || Number.isNaN(score)) return "unknown";
  if (score >= 0.8) return "high";
  if (score >= 0.55) return "medium";
  return "low";
}

export function recommendationReason({
  strategy = "",
  query = "",
  seedText = "",
  score = null,
  titleMatchesQuery = false,
} = {}) {
  const cleanQuery = String(query || "").trim();
  const cleanSeed = String(seedText || "").trim();

  if (titleMatchesQuery && cleanQuery) {
    return {
      reason_code: "title_match",
      reason: `Title match for "${cleanQuery}"`,
    };
  }

  if (strategy === "lexical" && cleanQuery) {
    return {
      reason_code: "lexical_match",
      reason: `Found by text match for "${cleanQuery}"`,
    };
  }

  if (strategy === "content" && cleanSeed) {
    return {
      reason_code: "similar_seed",
      reason: `Because it is similar to "${cleanSeed}"`,
    };
  }

  if (strategy === "semantic_fallback_seed" && cleanSeed) {
    return {
      reason_code: "semantic_seed",
      reason: `Because it is semantically similar to "${cleanSeed}"`,
    };
  }

  if (strategy === "cf_user") {
    return {
      reason_code: "personalized_popular",
      reason: "Popular with users and not already in your wishlist",
    };
  }

  if (strategy === "cf_global") {
    return {
      reason_code: "trending_global",
      reason: "Trending across MovieMix users",
    };
  }

  if (strategy === "catalog_fallback") {
    return {
      reason_code: "catalog_fallback",
      reason: "Popular fallback from the full catalog",
    };
  }

  if (strategy.startsWith("semantic")) {
    const bucket = scoreBucket(score);
    if (cleanQuery && bucket === "high") {
      return {
        reason_code: "semantic_strong",
        reason: `Strong semantic match for "${cleanQuery}"`,
      };
    }
    if (cleanQuery) {
      return {
        reason_code: "semantic_related",
        reason: `Semantically related to "${cleanQuery}"`,
      };
    }
    return {
      reason_code: "semantic_related",
      reason: "Semantically similar to your interests",
    };
  }

  return {
    reason_code: "generic",
    reason: "Recommended based on your activity",
  };
}

export function withRecommendationReason(items = [], context = {}) {
  return (items || []).map((item) => {
    const reason = recommendationReason({
      strategy: item._strategy || context.strategy,
      query: context.query,
      seedText: item._seed_text || context.seedText,
      score: item.score,
      titleMatchesQuery:
        item._title_matches_query === true || context.titleMatchesQuery === true,
    });

    const { _strategy, _seed_text, _title_matches_query, ...rest } = item;
    return { ...rest, ...reason };
  });
}

export function toAbSummary(rows = []) {
  const normalized = (rows || []).map((row) => {
    const variant = row.variant || "unknown";
    const impressions = Number(row.impressions || 0);
    const wishlist_adds = Number(row.wishlist_adds || 0);
    const watched = Number(row.watched || 0);
    const ratings = Number(row.ratings || 0);
    const conversions = Number(row.conversions || 0);

    const ctr = impressions > 0 ? conversions / impressions : 0;
    const wishlistRate = impressions > 0 ? wishlist_adds / impressions : 0;
    const watchRate = impressions > 0 ? watched / impressions : 0;
    const ratingRate = impressions > 0 ? ratings / impressions : 0;

    return {
      variant,
      impressions,
      wishlist_adds,
      watched,
      ratings,
      conversions,
      ctr,
      wishlist_rate: wishlistRate,
      watch_rate: watchRate,
      rating_rate: ratingRate,
      conversion_events_total: conversions,
    };
  });

  const winner = normalized
    .filter((v) => v.impressions > 0)
    .sort((a, b) => b.ctr - a.ctr)[0];

  const totals = normalized.reduce(
    (acc, row) => {
      acc.impressions += row.impressions;
      acc.conversions += row.conversions;
      return acc;
    },
    { impressions: 0, conversions: 0 }
  );
  totals.ctr = totals.impressions > 0 ? totals.conversions / totals.impressions : 0;

  return {
    variants: normalized,
    winner: winner
      ? { variant: winner.variant, ctr: winner.ctr, impressions: winner.impressions }
      : null,
    totals,
    definitions: {
      impressions: Array.from(IMPRESSION_EVENTS),
      conversions: Array.from(POSITIVE_CONVERSION_EVENTS),
    },
  };
}

