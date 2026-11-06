/**
 * Builds the generic foods file from authoritative sources:
 *
 *   npm run build:generics [-- --cache <dir>]
 *
 * Downloads the sources below (or reads them from the cache folder) and writes
 * src/food/data/generics.json, which is committed: the sources change at most a
 * few times a year, and the file is about 1.4 MB (about 310 KB gzipped, as it is
 * served). Run it when a source publishes a new release, after updating its URL here.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { GENERICS_FORMAT, type GenericsFile } from "../src/food/generics-format";
import { fromAfcd, fromFndds, type TableRow } from "./generics-builder";

const FSANZ = "https://www.foodstandards.gov.au/sites/default/files/2025-12/";
const SOURCES = {
  afcdNutrients: `${FSANZ}AFCD%20Release%203%20-%20Nutrient%20profiles.xlsx`,
  afcdDetails: `${FSANZ}AFCD%20Release%203%20-%20Food%20Details.xlsx`,
  fndds: "https://fdc.nal.usda.gov/fdc-datasets/FoodData_Central_survey_food_csv_2024-10-31.zip",
};
const OUT = "src/food/data/generics.json";

/** Must travel with the data (AFCD data user licence, clause 4A(b)). Same text as public/generics-LICENSE.txt. */
const NOTICE = readFileSync("public/generics-LICENSE.txt", "utf8");

async function fetchSource(url: string, cache: string | undefined): Promise<Uint8Array> {
  const file = cache ? join(cache, decodeURIComponent(url.slice(url.lastIndexOf("/") + 1))) : undefined;
  if (file && existsSync(file)) return readFileSync(file);
  process.stderr.write(`Downloading ${url}\n`);
  const res = await fetch(url, { headers: { "User-Agent": "FoodDiaryGenericsBuilder/1.0 (+https://github.com/Froussios/fitbit-nutrition-portal)" } });
  if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (file) {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, bytes);
  }
  return bytes;
}

/** The files in a zip archive, by path. Enough for these downloads: no zip64, stored or deflated. */
function readZip(zip: Uint8Array): Map<string, Uint8Array> {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = zip.length - 22;
  while (end >= 0 && view.getUint32(end, true) !== 0x06054b50) end--;
  if (end < 0) throw new Error("Not a zip file");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files = new Map<string, Uint8Array>();
  for (let i = 0; i < count; i++) {
    const method = view.getUint16(at + 10, true);
    const size = view.getUint32(at + 20, true);
    const nameLength = view.getUint16(at + 28, true);
    const extraLength = view.getUint16(at + 30, true);
    const commentLength = view.getUint16(at + 32, true);
    const local = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
    const data = zip.subarray(start, start + size);
    files.set(name, method === 0 ? data : new Uint8Array(inflateRawSync(data)));
    at += 46 + nameLength + extraLength + commentLength;
  }
  return files;
}

const xmlDecode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n))).replace(/&amp;/g, "&");

/** One sheet of a workbook as rows keyed by header, the header being the row that holds `firstColumn`. */
function readSheet(workbook: Uint8Array, sheetName: string, firstColumn: string): TableRow[] {
  const files = readZip(workbook);
  const text = (p: string) => new TextDecoder().decode(files.get(p));
  const shared = [...text("xl/sharedStrings.xml").matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) =>
    xmlDecode([...m[1]!.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")),
  );
  const rels = new Map([...text("xl/_rels/workbook.xml.rels").matchAll(/<Relationship\b[^>]*>/g)].map((m) => [/Id="([^"]+)"/.exec(m[0])![1], /Target="([^"]+)"/.exec(m[0])![1]!]));
  const sheet = [...text("xl/workbook.xml").matchAll(/<sheet\b[^>]*>/g)].find((m) => /name="([^"]+)"/.exec(m[0])![1] === xmlDecode(sheetName).replace(/&/g, "&amp;") || xmlDecode(/name="([^"]+)"/.exec(m[0])![1]!) === sheetName);
  if (!sheet) throw new Error(`No sheet "${sheetName}"`);
  const target = rels.get(/r:id="([^"]+)"/.exec(sheet[0])![1])!.replace(/^\//, "");
  const xml = text(target.startsWith("xl/") ? target : `xl/${target}`);

  const rows: Record<string, string>[] = [];
  for (const row of xml.matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: Record<string, string> = {};
    for (const c of row[1]!.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const column = /r="([A-Z]+)/.exec(c[1]!)![1]!;
      const type = /t="(\w+)"/.exec(c[1]!)?.[1];
      const body = c[2] ?? "";
      const value = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      if (type === "s" && value !== undefined) cells[column] = shared[Number(value)]!;
      else if (type === "inlineStr") cells[column] = xmlDecode([...body.matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
      else if (value !== undefined) cells[column] = xmlDecode(value);
    }
    rows.push(cells);
  }
  const clean = (s: string) => s.replace(/\s+/g, " ").trim();
  const headerAt = rows.findIndex((r) => Object.values(r).some((v) => clean(v) === firstColumn));
  if (headerAt < 0) throw new Error(`No header row in "${sheetName}"`);
  const header = Object.entries(rows[headerAt]!).map(([column, title]) => [column, clean(title)] as const);
  return rows.slice(headerAt + 1).map((r) => Object.fromEntries(header.map(([column, title]) => [title, r[column]])));
}

function parseCsv(bytes: Uint8Array): TableRow[] {
  const text = new TextDecoder().decode(bytes);
  const records: string[][] = [];
  let field = "";
  let record: string[] = [];
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"' && text[i + 1] === '"') {
        field += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      record.push(field);
      field = "";
    } else if (ch === "\n") {
      record.push(field.replace(/\r$/, ""));
      records.push(record);
      field = "";
      record = [];
    } else field += ch;
  }
  if (field || record.length > 0) records.push([...record, field]);
  const [header, ...rows] = records;
  return rows.map((r) => Object.fromEntries(header!.map((h, i) => [h, r[i]])));
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cacheAt = argv.indexOf("--cache");
  const cache = cacheAt >= 0 ? argv[cacheAt + 1] : undefined;

  const nutrients = await fetchSource(SOURCES.afcdNutrients, cache);
  const details = await fetchSource(SOURCES.afcdDetails, cache);
  const afcd = fromAfcd(
    readSheet(nutrients, "All solids & liquids per 100 g", "Public Food Key"),
    readSheet(nutrients, "Liquids only per 100 mL", "Public Food Key"),
    readSheet(details, "Food details", "Public Food Key"),
  );

  const zip = readZip(await fetchSource(SOURCES.fndds, cache));
  const csv = (name: string) => {
    const path = [...zip.keys()].find((p) => p.endsWith(`/${name}`));
    if (!path) throw new Error(`FNDDS: no ${name}`);
    return parseCsv(zip.get(path)!);
  };
  const fndds = fromFndds(csv("food.csv"), csv("food_nutrient.csv"), csv("food_portion.csv"));

  const file: GenericsFile = {
    format: GENERICS_FORMAT,
    sources: [
      { source: "afcd", title: "Australian Food Composition Database, Release 3 (Food Standards Australia New Zealand)", url: "https://www.foodstandards.gov.au/science-data/food-nutrient-databases/afcd", licence: "AFCD data user licence, based on CC BY-SA 3.0 AU" },
      { source: "fndds", title: "USDA Food and Nutrient Database for Dietary Studies 2021-2023 (FoodData Central)", url: "https://fdc.nal.usda.gov/", licence: "US public domain" },
    ],
    notice: NOTICE,
    foods: [...afcd, ...fndds],
  };
  mkdirSync(dirname(OUT), { recursive: true });
  const json = `{${Object.entries(file).filter(([k]) => k !== "foods").map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(",\n")},\n"foods":[\n${file.foods.map((r) => JSON.stringify(r)).join(",\n")}\n]}\n`;
  writeFileSync(OUT, json);
  process.stdout.write(`${OUT}: ${afcd.length} AFCD foods, ${fndds.length} FNDDS foods, ${Math.round(json.length / 1024)} KB\n`);
}

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
