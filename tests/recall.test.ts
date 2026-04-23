import { describe, it, expect } from "vitest";
import { blendScores, isAdviceSeekingQuery } from "../src/recall.js";

describe("isAdviceSeekingQuery", () => {
  describe("matches advice-seeking queries", () => {
    const positives = [
      "Can you recommend some resources for learning Python?",
      "Any tips for better sleep?",
      "What would you recommend for a 10-year-old's birthday?",
      "Give me some advice on buying my first car",
      "Help me choose between the two options",
      "I need some suggestions for weekend activities",
      "Can you suggest a good hotel in Tokyo?",
      "What are some good places to eat downtown?",
      "Best way to learn TypeScript quickly",
      "Any good recommendations for running shoes?",
    ];
    for (const q of positives) {
      it(`matches: "${q}"`, () => {
        expect(isAdviceSeekingQuery(q)).toBe(true);
      });
    }
  });

  describe("does NOT match retrospective assistant-recall queries", () => {
    // These LOOK advice-seeking but are actually looking up a past
    // assistant turn — they should keep the cross-encoder reranker
    // because it's good at matching specific entities.
    const retrospectives = [
      "Can you remind me of the name of the romantic Italian restaurant you recommended for dinner?",
      "In our previous chat, you suggested a few options for alternative terms",
      "I was going back to our previous conversation about music theory",
      "What was the name of that hostel near the center you recommended?",
      "Going back to what you told me last time about tea tree oil",
      "In our last session you mentioned some online resources",
    ];
    for (const q of retrospectives) {
      it(`does NOT match: "${q.slice(0, 60)}..."`, () => {
        expect(isAdviceSeekingQuery(q)).toBe(false);
      });
    }
  });

  describe("does NOT match direct lookup queries", () => {
    // These are the queries the cross-encoder reranker excels at —
    // direct factual lookups with specific entities.
    const directLookups = [
      "What's my favorite coffee order?",
      "When did I start learning guitar?",
      "Who did I meet at the conference last week?",
      "What was the first issue I had with my new car?",
      "Which event did I attend first?",
      "Did I ever mention my allergies?",
    ];
    for (const q of directLookups) {
      it(`does NOT match: "${q}"`, () => {
        expect(isAdviceSeekingQuery(q)).toBe(false);
      });
    }
  });

  describe("edge cases", () => {
    it("handles empty string", () => {
      expect(isAdviceSeekingQuery("")).toBe(false);
    });

    it("handles whitespace-only string", () => {
      expect(isAdviceSeekingQuery("   ")).toBe(false);
    });

    it("is case-insensitive", () => {
      expect(isAdviceSeekingQuery("CAN YOU RECOMMEND A BOOK?")).toBe(true);
      expect(isAdviceSeekingQuery("any ADVICE would help")).toBe(true);
    });
  });
});

describe("blendScores", () => {
  it("blend=0 returns the pure bi-encoder signal (normalized)", () => {
    // bi=[1,2,3] normalizes to [0, 0.5, 1]. ce values are irrelevant at b=0.
    const out = blendScores([1, 2, 3], [100, 50, -20], 0);
    expect(out[0]).toBeCloseTo(0, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(1, 5);
  });

  it("blend=1 returns the pure cross-encoder signal (normalized)", () => {
    // ce=[100,50,-20] normalizes to [1, 0.583..., 0]. bi is irrelevant at b=1.
    const out = blendScores([0.9, 0.5, 0.1], [100, 50, -20], 1);
    expect(out[0]).toBeCloseTo(1, 5);
    expect(out[1]).toBeCloseTo((50 - -20) / (100 - -20), 5);
    expect(out[2]).toBeCloseTo(0, 5);
  });

  it("blend=0.5 equally weights normalized bi and ce", () => {
    // bi=[0,1,2] -> [0, 0.5, 1]; ce=[2,1,0] -> [1, 0.5, 0]
    // 0.5 blend -> [0.5, 0.5, 0.5]
    const out = blendScores([0, 1, 2], [2, 1, 0], 0.5);
    expect(out[0]).toBeCloseTo(0.5, 5);
    expect(out[1]).toBeCloseTo(0.5, 5);
    expect(out[2]).toBeCloseTo(0.5, 5);
  });

  it("preserves relative order when ce agrees with bi", () => {
    const out = blendScores([0.1, 0.5, 0.9], [-5, 0, 6], 0.5);
    expect(out[0]).toBeLessThan(out[1]);
    expect(out[1]).toBeLessThan(out[2]);
  });

  it("flips order when ce disagrees strongly and blend favors ce", () => {
    // bi prefers index 2; ce prefers index 0. blend=0.9 -> ce dominates.
    const out = blendScores([0.1, 0.5, 0.9], [10, 0, -10], 0.9);
    expect(out[0]).toBeGreaterThan(out[2]);
  });

  it("clamps blend > 1 to 1", () => {
    const clamped = blendScores([0.1, 0.9], [100, 0], 1.5);
    const exact = blendScores([0.1, 0.9], [100, 0], 1);
    expect(clamped).toEqual(exact);
  });

  it("clamps blend < 0 to 0", () => {
    const clamped = blendScores([0.1, 0.9], [100, 0], -0.3);
    const exact = blendScores([0.1, 0.9], [100, 0], 0);
    expect(clamped).toEqual(exact);
  });

  it("returns 0.5 for every element when all scores are equal in an array", () => {
    const out = blendScores([0.5, 0.5, 0.5], [2, 2, 2], 0.5);
    expect(out).toEqual([0.5, 0.5, 0.5]);
  });

  it("returns an empty array for empty input", () => {
    expect(blendScores([], [], 0.5)).toEqual([]);
  });

  it("throws when input arrays are different lengths", () => {
    expect(() => blendScores([0.1, 0.2], [1, 2, 3], 0.5)).toThrow();
  });
});
