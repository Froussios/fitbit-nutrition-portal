import { describe, expect, it } from "vitest";
import { compareRank, highlightRuns, indexWords, nameWords, parseQuery, productMatches } from "../src/core/tokens";

describe("words", () => {
  it("folds case and accents and drops stop words and single letters", () => {
    expect(nameWords("Crème Brûlée with Berries & Cream")).toEqual(["creme", "brulee", "berries", "cream"]);
    expect(nameWords("7 Up")).toEqual(["7", "up"]);
  });

  it("indexes hyphenated and apostrophe words both split and joined", () => {
    expect(indexWords("Weet-Bix")).toEqual(["weet", "bix", "weetbix"]);
    expect(indexWords("McDonald's Big Mac")).toEqual(["mcdonald", "mcdonalds", "big", "mac"]);
    // Coverage counts the parts, not the joined form.
    expect(nameWords("Weet-Bix")).toEqual(["weet", "bix"]);
  });
});

describe("parseQuery", () => {
  it("treats the last word as a prefix while typing", () => {
    expect(parseQuery("dark choc")).toEqual({ words: ["dark"], prefix: "choc" });
    expect(parseQuery("dark choc ")).toEqual({ words: ["dark", "choc"] });
  });

  it("ignores a one-letter last word and stop words", () => {
    expect(parseQuery("milk c")).toEqual({ words: ["milk"] });
    expect(parseQuery("bread and b")).toEqual({ words: ["bread"] });
  });

  it("splits hyphenated query words", () => {
    expect(parseQuery("Weet-Bix")).toEqual({ words: ["weet"], prefix: "bix" });
  });
});

describe("matching", () => {
  it("needs every word, in any order, in the name or brand", () => {
    expect(productMatches(parseQuery("chocolate dark "), "Dark Chocolate")).toBe(true);
    expect(productMatches(parseQuery("cadbury choc"), "Dairy Milk Chocolate", "Cadbury")).toBe(true);
    expect(productMatches(parseQuery("white chocolate "), "Dark Chocolate")).toBe(false);
  });

  it("does not tolerate typos", () => {
    expect(productMatches(parseQuery("chocloate "), "Chocolate")).toBe(false);
  });

  it("finds joined words from either spelling", () => {
    expect(productMatches(parseQuery("weetbix"), "Weet-Bix")).toBe(true);
    expect(productMatches(parseQuery("weet bix"), "Weet-Bix")).toBe(true);
  });
});

describe("ranking", () => {
  it("puts names the query covers more first, then popular ones", () => {
    const items = [
      { nameWordCount: 2, popularity: 9, key: "dark chocolate" },
      { nameWordCount: 1, popularity: 0, key: "chocolate" },
      { nameWordCount: 2, popularity: 3, key: "milk chocolate" },
    ];
    expect([...items].sort(compareRank).map((i) => i.key)).toEqual(["chocolate", "dark chocolate", "milk chocolate"]);
  });
});

describe("highlightRuns", () => {
  it("marks matched words and keeps the original text", () => {
    expect(highlightRuns("Dark Chocolate, 70%", parseQuery("choc"))).toEqual([
      { text: "Dark ", match: false },
      { text: "Chocolate", match: true },
      { text: ", 70%", match: false },
    ]);
  });

  it("marks a hyphenated word whose joined form matched", () => {
    expect(highlightRuns("Weet-Bix", parseQuery("weetbix"))).toEqual([{ text: "Weet-Bix", match: true }]);
  });
});
