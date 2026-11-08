/**
 * Builds the static food index from the Open Food Facts JSONL export.
 *
 *   curl -sSfL https://static.openfoodfacts.org/data/openfoodfacts-products.jsonl.gz \
 *     | gzip -dc | node --max-old-space-size=6144 --import tsx pipeline/build-index.ts --out public/food-index
 *
 * Options:
 *   --out <dir>          index root (default public/food-index); holds current.json and one version folder
 *   --input <file>       read this file instead of stdin (.gz is decompressed)
 *   --version <name>     version folder name; must be unique per build, because browsers cache version
 *                        folders as immutable (default: UTC build time, e.g. 20261104T085100Z)
 *   --source-url <url>   recorded in meta.json
 *   --last-modified <s>  the export's Last-Modified date, recorded in meta.json
 *   --limit <n>          stop after n records (for trying it out)
 *   --max-files <n>      file budget for the whole index folder (default 19000; Cloudflare Pages allows 20,000)
 *   --owner <repo>       written to food-index-owner.json, so a deploy can check it only ever replaces its own site
 *
 * Prints a Markdown report (counts and sizes) to stdout.
 */
import { createReadStream, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { IndexBuilder, type RawProduct } from "./index-builder";

function args(): Map<string, string> {
  const out = new Map<string, string>();
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) throw new Error(`Unexpected argument: ${a}`);
    out.set(a.slice(2), argv[++i] ?? "");
  }
  return out;
}

async function main(): Promise<void> {
  const opts = args();
  const outRoot = opts.get("out") ?? "public/food-index";
  // Unique per build: two builds never share a version folder, or browsers would mix their cached files.
  const version = opts.get("version") ?? new Date().toISOString().replace(/[-:]|\.\d+/g, "");
  if (!/^[A-Za-z0-9._-]+$/.test(version)) throw new Error(`Invalid version name: ${version}`);
  const limit = Number(opts.get("limit") ?? Infinity);
  const input = opts.get("input");
  const source = {
    ...(opts.get("source-url") ? { url: opts.get("source-url")! } : {}),
    ...(opts.get("last-modified") ? { lastModified: opts.get("last-modified")! } : {}),
  };

  const stream = input ? (input.endsWith(".gz") ? createReadStream(input).pipe(createGunzip()) : createReadStream(input)) : process.stdin;
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const maxFiles = Number(opts.get("max-files") ?? 19_000);
  const builder = new IndexBuilder({ version, source, maxFiles });
  const started = Date.now();
  let n = 0;
  let badJson = 0;
  for await (const line of lines) {
    if (n++ >= limit) break;
    // Every kept product needs an energy value; skip the JSON parse for lines that cannot have one.
    if (!line.includes('"energy')) {
      builder.counts["read"] = (builder.counts["read"] ?? 0) + 1;
      builder.counts["dropped.noEnergy"] = (builder.counts["dropped.noEnergy"] ?? 0) + 1;
      continue;
    }
    let raw: RawProduct;
    try {
      raw = JSON.parse(line) as RawProduct;
    } catch {
      badJson++;
      continue;
    }
    builder.add(raw);
    if (n % 250_000 === 0) process.stderr.write(`${n} records read, ${builder.counts["kept"] ?? 0} kept\n`);
  }
  if (badJson) builder.counts["dropped.badJson"] = badJson;
  process.stderr.write(`Read ${n} records in ${Math.round((Date.now() - started) / 1000)} s; writing the index\n`);

  // Write the new version next to the old one, switch current.json, then remove the old ones.
  const versionDir = join(outRoot, version);
  rmSync(versionDir, { recursive: true, force: true });
  let files = 0;
  let bytes = 0;
  let largest = 0;
  const sizes = new Map<string, number>();
  for (const [path, contents] of builder.files()) {
    const file = join(versionDir, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, contents);
    const size = typeof contents === "string" ? Buffer.byteLength(contents) : contents.length;
    files++;
    bytes += size;
    largest = Math.max(largest, size);
    const top = path.split("/")[0]!;
    sizes.set(top, (sizes.get(top) ?? 0) + size);
  }
  writeFileSync(join(outRoot, "current.json"), JSON.stringify({ version }));
  for (const entry of readdirSync(outRoot)) {
    const p = join(outRoot, entry);
    if (entry !== version && statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true });
  }
  writeFileSync(join(versionDir, "LICENSE.txt"), LICENCE);
  // Cloudflare Pages: version folders never change, so browsers may cache them for good.
  // current.json keeps Pages' default (revalidate every time). Pages already sends Access-Control-Allow-Origin: *.
  writeFileSync(join(outRoot, "_headers"), "/:version/*\n  Cache-Control: public, max-age=31536000, immutable\n");
  // Ownership marker: the deploy workflow refuses to overwrite a Pages project that does not serve this file.
  writeFileSync(join(outRoot, "food-index-owner.json"), JSON.stringify({ repository: opts.get("owner") ?? "local", purpose: "Food Diary food search index" }));
  // Only the meal prep API runs the Pages Function; every index file stays static, and outside its daily request allowance (DR-24).
  writeFileSync(join(outRoot, "_routes.json"), JSON.stringify({ version: 1, include: ["/api/*"], exclude: [] }));
  files += 5;

  const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;
  const report = [
    `## Food index ${version}`,
    "",
    `Built in ${Math.round((Date.now() - started) / 1000)} s from ${source.url ?? input ?? "stdin"}${source.lastModified ? ` (export of ${source.lastModified})` : ""}.`,
    "",
    "| Count | Value |",
    "|---|---|",
    ...Object.entries(builder.counts).map(([k, v]) => `| ${k} | ${v.toLocaleString("en-AU")} |`),
    "",
    "| Folder | Size |",
    "|---|---|",
    ...[...sizes].sort((a, b) => b[1] - a[1]).map(([k, v]) => `| ${k} | ${mb(v)} |`),
    `| **total** | **${mb(bytes)}** in ${files.toLocaleString("en-AU")} files (largest ${mb(largest)}) |`,
  ].join("\n");
  process.stdout.write(`${report}\n`);

  if (files > maxFiles) throw new Error(`Index has ${files} files, over the limit of ${maxFiles}`);
  if (largest > 20e6) throw new Error(`A file is ${mb(largest)}, over the 20 MB limit (Cloudflare Pages allows 25 MiB)`);
  if (!existsSync(join(versionDir, "meta.json"))) throw new Error("meta.json was not written");
}

const LICENCE = `Food index derived from Open Food Facts.

Contains information from Open Food Facts (https://world.openfoodfacts.org),
made available under the Open Database License (ODbL) 1.0:
https://opendatacommons.org/licenses/odbl/1-0/

This derived database is likewise made available under the ODbL 1.0. Individual
contents of the database are under the Database Contents License:
https://opendatacommons.org/licenses/dbcl/1-0/

Built by pipeline/build-index.ts in https://github.com/Froussios/fitbit-nutrition-portal
`;

main().catch((e: unknown) => {
  process.stderr.write(`${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
  process.exit(1);
});
