import fs from "node:fs";
import path from "node:path";
const dirs = [
  "atlas",
  "builder",
  "crafter",
  "css",
  "custom",
  "data",
  "dev",
  "downloads",
  "encoding_test",
  "ingredient",
  "ingredients",
  "ingredients_adv",
  "item",
  "items",
  "items_adv",
  "js",
  "map",
  "media",
  "sets",
  "test_data",
  "thirdparty",
  "wynnfo",
];
// Retain every upstream data version, route and native asset.
const output = path.resolve("dist");
fs.rmSync(output, { recursive: true, force: true });
fs.mkdirSync(output, { recursive: true });
for (const dir of dirs)
  if (fs.existsSync(dir))
    fs.cpSync(dir, path.join(output, dir), { recursive: true });
for (const name of fs.readdirSync(".")) {
  if (
    name.endsWith(".html") ||
    ["LICENSE.txt", "credits.txt", "manifest.json", "ENCODING.md"].includes(
      name,
    )
  )
    fs.copyFileSync(name, path.join(output, name));
}
console.log(
  "Built the static site in dist. Serve its root and open /builder/.",
);
