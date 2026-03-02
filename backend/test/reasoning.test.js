import test from "node:test";
import assert from "node:assert/strict";

import {
  recommendationReason,
  toAbSummary,
  withRecommendationReason,
} from "../src/utils/reasoning.js";

test("recommendationReason returns title_match for exact query title match", () => {
  const out = recommendationReason({
    strategy: "semantic",
    query: "dune",
    titleMatchesQuery: true,
  });
  assert.equal(out.reason_code, "title_match");
  assert.match(out.reason, /dune/i);
});

test("withRecommendationReason injects reason fields and removes private props", () => {
  const rows = withRecommendationReason(
    [
      {
        title_id: 1,
        title: "Interstellar",
        score: 0.92,
        _strategy: "semantic",
        _title_matches_query: false,
      },
    ],
    { query: "space" }
  );

  assert.equal(rows.length, 1);
  assert.ok(rows[0].reason);
  assert.ok(rows[0].reason_code);
  assert.equal("_strategy" in rows[0], false);
  assert.equal("_title_matches_query" in rows[0], false);
});

test("toAbSummary computes variant ctr and winner", () => {
  const summary = toAbSummary([
    {
      variant: "A",
      impressions: 100,
      wishlist_adds: 10,
      watched: 6,
      ratings: 4,
      conversions: 20,
    },
    {
      variant: "B",
      impressions: 100,
      wishlist_adds: 8,
      watched: 4,
      ratings: 3,
      conversions: 15,
    },
  ]);

  assert.equal(summary.variants.length, 2);
  assert.equal(summary.winner?.variant, "A");
  assert.equal(summary.totals.impressions, 200);
  assert.equal(summary.totals.conversions, 35);
  assert.equal(summary.variants[0].ctr > 0, true);
});

