import { describe, it, expect } from "vitest";
import { isAdviceSeekingQuery } from "../src/recall.js";

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
