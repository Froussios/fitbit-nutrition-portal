import { describe, expect, it } from "vitest";
import { compareMatch, compareRank, headWords, highlightRuns, indexWords, matchRank, nameWordCount, nameWords, parseQuery, productMatches, productWordCount } from "../src/core/tokens";

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

describe("headWords", () => {
  it("takes the last word as the food", () => {
    expect(headWords("Dark chocolate")).toEqual(["chocolate"]);
    expect(headWords("Chocolate milk")).toEqual(["milk"]);
    expect(headWords("Vegemite pressed pretzels")).toEqual(["pretzels"]);
    expect(headWords("Vegemite flavoured pretzels")).toEqual(["pretzels"]);
  });

  it("ignores sizes and what comes after a qualifier", () => {
    expect(headWords("Vegemite 455g")).toEqual(["vegemite"]);
    expect(headWords("Cheesy bread sticks with vegemite")).toEqual(["sticks"]);
    expect(headWords("Sardines in tomato sauce")).toEqual(["sardines"]);
    expect(headWords("Coke, large")).toEqual(["coke"]);
    expect(headWords("With love")).toEqual(["love"]);
  });

  it("passes a form word on to the food before it", () => {
    expect(headWords("Boneless Chicken Breast")).toEqual(["breast", "chicken"]);
    expect(headWords("Vanilla extract")).toEqual(["extract", "vanilla"]);
    expect(headWords("Vanilla Bean Ice Cream")).toEqual(["cream"]);
  });

  it("keeps a hyphenated word whole", () => {
    expect(headWords("Weet-Bix")).toEqual(["weet", "bix", "weetbix"]);
    expect(headWords("Peanut Butter-Honey")).toEqual(["butter", "honey", "butterhoney"]);
  });
});

describe("fixed ranking", () => {
  it("puts unbranded products first, then shorter names, then shorter brands, then popular ones", () => {
    const items = [
      { branded: true, nameWordCount: 1, productWordCount: 3, sameNameCount: 1, popularity: 9, key: "long brand" },
      { branded: true, nameWordCount: 1, productWordCount: 2, sameNameCount: 1, popularity: 0, key: "short brand" },
      { branded: false, nameWordCount: 2, productWordCount: 2, sameNameCount: 1, popularity: 9, key: "probiotic chocolate" },
      { branded: false, nameWordCount: 2, productWordCount: 2, sameNameCount: 300, popularity: 0, key: "milk chocolate" },
      { branded: false, nameWordCount: 2, productWordCount: 2, sameNameCount: 1, popularity: 3, key: "roses chocolate" },
      { branded: false, nameWordCount: 1, productWordCount: 1, sameNameCount: 1, popularity: 0, key: "chocolate" },
    ];
    expect([...items].sort(compareRank).map((i) => i.key)).toEqual(["chocolate", "milk chocolate", "probiotic chocolate", "roses chocolate", "short brand", "long brand"]);
  });

  it("counts a repeated word once", () => {
    expect(nameWordCount("Vanilla Vanilla")).toBe(1);
    expect(nameWordCount("Vanilla Bean")).toBe(2);
    expect(nameWordCount("&")).toBe(1);
    expect(productWordCount("Vegemite", "Vegemite")).toBe(1);
    expect(productWordCount("Vegemite", "Bega Foods")).toBe(3);
    expect(productWordCount("Chocolate", "M&M's")).toBe(3);
    expect(nameWordCount("O.G. Vanilla")).toBe(3);
    expect(nameWordCount("A taste of honey")).toBe(2);
  });
});

describe("matchRank", () => {
  const order = (query: string, products: readonly (readonly [string, string?])[]) => {
    const q = parseQuery(query);
    return [...products]
      .sort((a, b) => compareMatch(matchRank(q, a[0], a[1]), matchRank(q, b[0], b[1])))
      .map(([name, brand]) => (brand ? `${name} (${brand})` : name));
  };

  it("orders a one-word search: generic, then branded names, then brand-only", () => {
    expect(
      order("vanilla", [
        ["Yogurt", "Vanilla Queen"],
        ["Vanilla extract", "Queen"],
        ["Vanilla", "Queen"],
        ["Vanilla", "Vanilla Queen"],
        ["Vanilla extract"],
      ]),
    ).toEqual(["Vanilla extract", "Vanilla (Vanilla Queen)", "Vanilla (Queen)", "Vanilla extract (Queen)", "Yogurt (Vanilla Queen)"]);
  });

  it("orders a two-word search by what the query leaves unexplained", () => {
    expect(
      order("vanilla queen", [
        ["Yogurt", "Vanilla queen"],
        ["Vanilla queen flavour", "Other"],
        ["Vanilla", "Queen"],
        ["Vanilla queen", "Other"],
      ]),
    ).toEqual(["Vanilla (Queen)", "Vanilla queen (Other)", "Vanilla queen flavour (Other)", "Yogurt (Vanilla queen)"]);
  });

  it("puts the food before products it only flavours", () => {
    expect(
      order("vegemite", [
        ["Vegemite pretzels"],
        ["Vegemite", "Bega"],
        ["Vegemite", "Vegemite"],
        ["Vegemite"],
      ]),
    ).toEqual(["Vegemite", "Vegemite (Vegemite)", "Vegemite (Bega)", "Vegemite pretzels"]);
    expect(
      order("chocolate", [
        ["Chocolate milk"],
        ["Chocolate", "Lindt"],
        ["Dark chocolate", "Lindt"],
        ["Milk chocolate"],
      ]),
    ).toEqual(["Milk chocolate", "Chocolate (Lindt)", "Dark chocolate (Lindt)", "Chocolate milk"]);
    expect(order("milk", [["Milk chocolate"], ["Whole milk"]])).toEqual(["Whole milk", "Milk chocolate"]);
  });

  it("puts a product the query uses up before anything that more typing could reach", () => {
    expect(
      order("vegemite", [
        ["Vegemite pretzels", "Bega"],
        ["Vegemite", "Bega"],
        ["Vegemite", "Vegemite"],
        ["Vegemite"],
      ]),
    ).toEqual(["Vegemite", "Vegemite (Vegemite)", "Vegemite (Bega)", "Vegemite pretzels (Bega)"]);
    expect(order("vegemite", [["Vegemite scroll"], ["Vegemite", "Vegemite"]])).toEqual(["Vegemite (Vegemite)", "Vegemite scroll"]);
  });

  it("puts whole words before longer words that start the same, even generic ones", () => {
    expect(order("coke", [["Krim cokelat"], ["Coke", "Coca-Cola"], ["Coke"]])).toEqual(["Coke", "Coke (Coca-Cola)", "Krim cokelat"]);
    expect(order("big mac", [["Macaroni", "Big Win"], ["Big Mac", "Maccas"], ["Big Mac Bowl"]])).toEqual(["Big Mac (Maccas)", "Big Mac Bowl", "Macaroni (Big Win)"]);
  });

  it("does not treat a brand with no countable words as used up", () => {
    expect(order("chocolate", [["Chocolate", "M&M's"], ["Dark chocolate"], ["Chocolate", "Chocolate"]])).toEqual(["Chocolate (Chocolate)", "Dark chocolate", "Chocolate (M&M's)"]);
  });

  it("does not treat a name with stray letters as used up", () => {
    expect(order("chocolate", [["W A F E R Chocolate"], ["M&m's, chocolate"], ["Dark chocolate"], ["Chocolate"]])[0]).toBe("Chocolate");
    expect(order("chicken", [["b&b chicken"], ["Chicken", "Chicken"]])).toEqual(["Chicken (Chicken)", "b&b chicken"]);
  });

  it("still ranks while the last word is half typed", () => {
    expect(order("vani", [["Yogurt", "Vanilla Queen"], ["Vanilla extract"], ["Vanilla"]])).toEqual(["Vanilla", "Vanilla extract", "Yogurt (Vanilla Queen)"]);
  });

  it("treats a joined word as covering its parts", () => {
    expect(order("weetbix ", [["Weet-Bix Blend"], ["Weet-Bix"]])).toEqual(["Weet-Bix", "Weet-Bix Blend"]);
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
