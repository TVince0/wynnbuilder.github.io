# Native build optimizer

This fork extends the existing WynnBuilder page. Open `/builder/` and use its normal gear inputs, tome selectors, powder inputs and ability tree. The optimizer uses the loaded WynnBuilder version and native item definitions.

## Run locally

Node.js 22 or newer is required for the development commands.

```sh
pnpm dev
```

Open `http://127.0.0.1:8000/builder/`. The development server requires no installed packages. `npm run dev` runs the same command. You can also serve the repository root using Python.

```sh
python3 -m http.server 8000 --bind 127.0.0.1
```

To produce a static site, run `pnpm build`. It copies the site's routes, scripts, assets and every upstream data version into `dist`. Run `pnpm preview` to serve that directory. Host the contents of `dist` at the origin root, then open `/builder/`.

## Search a loadout

1. Choose a character level in the native builder.
2. Select any owned gear in the normal autocomplete inputs. Under the optimizer, lock the corresponding slots.
3. Use **Actual rolls** to enter the identified values for a locked piece. Blank fields follow the roll scenario. Zero and negative values are valid.
4. Choose the search class, minimum candidate level and optional tier. Select optimistic, realistic or pessimistic rolls.
5. Add minimum and maximum stat targets, select the ranking metric and choose the number of results.
6. Select tomes in the native tome section. The search includes their stats and uses the selected guild tome for skill requirements. An empty guild tome slot contributes no bonus.
7. Select **Find functioning builds**. **Use this build** applies its exact items, scenario and minimum allocation to the same native builder.

Optimistic uses each identification's native best endpoint. Pessimistic uses its worst endpoint. Realistic uses the rounded midpoint. These are deterministic assumptions about item quality. The optimizer uses the same native item expander and rounding as the builder. Two locked copies of a ring keep independent actual values.

The native **Copy short** and **Copy for sharing** links retain scenario and owned-roll data in an `optimizer` query parameter alongside WynnBuilder's normal hash. Open those links on this fork to restore the values. The upstream site uses its own default roll behavior.

## Functioning builds and skill points

Every returned result must satisfy the complete loadout's skill requirements. There is no switch to disable this validation.

The Fruma update removed the armour equip-order requirement. For each skill, the allocator sums the bonuses from non-crafted armour/accessories and the selected guild tome. Each piece's own bonus is removed when checking its requirement. Weapon, crafted and set skill bonuses contribute to final skills, but cannot unlock gear requirements. Requirements at or below zero require no allocation.

The allocator finds the minimum manual points satisfying every final requirement, including the weapon. The sum must fit `min(200, 2 × (level − 1))` and each manually allocated skill must be at most 100. The guild tome lowers the necessary manual allocation through its skill bonuses. The guild tome slot requires level 105.

The search accounts for possible support from every future armour/accessory slot when deciding whether a partial branch could work. A piece that is unusable alone can remain a candidate when another piece could make the complete build valid. Both the normal builder and the optimizer call the same allocator.

[Fruma equipment changes](https://wynncraft.wiki.gg/wiki/Version_2.2) · [Skill points](https://wynncraft.wiki.gg/wiki/Skills) · [Skill-point identifications](https://wynncraft.wiki.gg/wiki/Identifications)

## Search metrics and full builder calculations

Candidate measurements use native `Item`, `Build`, powder application, set aggregation, skill allocation and `getDefenseStats`. Supported metrics include raw IDs, health, health regen, effective HP, effective regen, maximum mana and final skills. The search uses the minimum valid allocation and leaves spare points unassigned.

The search score includes equipped tome stats, guild points, item rolls, numeric set bonuses and the powders currently entered for each slot. Ability trees, aspects, raid buffs and activated powder specials are evaluated by the normal builder after applying a result. These effects can change its final combat display. You can use all those native controls on the result.

The background Worker first finds feasible candidate builds, then performs an exhaustive search with safe score, target and skill bounds. Results shown during a run are the best found so far. A finished search has the exact retained top scores for its selected search model. Large pools and nonlinear metrics can take a long time. Pins, candidate JSON and the level/tier filters reduce work. Cancelling preserves the results already found. Applying an interim result stops the current search.

## Candidate JSON

The built-in native database is the default source. An imported file can select a smaller pool. It can be a JSON list of native item names or a WynnBuilder data file containing an `items` array. Official API exports with matching internal names are also accepted. Items missing from the loaded native version are reported before changing the pool.

```json
{
  "items": ["Third Eye", "Aquarius", "Vaward", "Memento", "Concentration", "Prism", "Prowess", "Diamond Hydro Necklace", "Cascade"]
}
```

Imports select native templates from the currently loaded version. Use **Actual rolls** for owned values and the native custom/crafting tools for new gear definitions. An imported pool needs an eligible item for every unlocked slot. Locked items stay eligible even when omitted from the imported list. **Use full database** clears the pool filter.

## Verification

```sh
pnpm install
pnpm test
pnpm test:integration
pnpm build
node tests/native-page.mjs dist
```

The dependency-free core tests cover mutual support, the exclusion of a piece's own bonus, crafted/weapon/set exclusions, guild support, point caps, future support, native roll scenarios and exhaustive rank comparisons. The DOM integration test mounts the actual builder page and its scripts. It checks search and application against the native compute graph, owned zero rolls, share-query preservation and selected guild tome changes. It can run against the generated static site.
