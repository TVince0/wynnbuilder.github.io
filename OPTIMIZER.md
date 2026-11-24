# Native build optimizer

This fork extends the existing WynnBuilder page. Open `/builder/` and use its normal gear inputs, tome selectors, powder inputs and ability tree. The optimizer uses the loaded WynnBuilder version and native item definitions.

## Run locally

The local CUDA backend requires Node.js 22+, Python 3.10+, and a CUDA-capable NVIDIA GPU with a compatible NVIDIA driver. Install its Python dependencies once, check the GPU/compiler, and start the site.

```sh
pnpm cuda:setup
pnpm cuda:check
pnpm dev
```

Open `http://127.0.0.1:8000/builder/`. Setup creates `backend/.venv` and installs NumPy and NVIDIA NVRTC. The backend compiles its CUDA kernel at runtime. See [CUDA setup and tuning](backend/README.md) for device/Python selection and the GPU/native calculation split.

`pnpm build` creates `dist`. `pnpm preview` serves that site with the same local CUDA API. Keep the repository's backend and scripts beside it. Serving only static files supports the explicit CPU search modes. The CUDA mode calls the local service and reports an error if it is unavailable.

## Search a loadout

1. Choose a character level in the native builder.
2. In **Equipment**, select **Choose** beside a slot to open its gear picker. Use **Back to optimizer**, then check the slots you want to lock.
3. Use **Edit rolls** to enter the identified values for a locked piece. Blank fields follow the roll scenario. Zero and negative values are valid.
4. Choose the search class, minimum candidate level and optional tier. Select optimistic, realistic or pessimistic rolls.
5. Add minimum and maximum stat targets, select the ranking metric and choose the number of results.
6. Select tomes in the native tome section. The search includes their stats and uses the selected guild tome for skill requirements. An empty guild tome slot contributes no bonus.
7. Select **Find builds**. **Use this build** applies its exact items, scenario and minimum allocation to the same native builder.

Optimistic uses each identification's native best endpoint. Pessimistic uses its worst endpoint. Realistic uses the rounded midpoint. These are deterministic assumptions about item quality. The optimizer uses the same native item expander and rounding as the builder. Two locked copies of a ring keep independent actual values.

The native **Copy short** and **Copy for sharing** links retain scenario and owned-roll data in an `optimizer` query parameter alongside WynnBuilder's normal hash. Open those links on this fork to restore the values. The upstream site uses its own default roll behavior.

## Functioning builds and skill points

Every returned result must satisfy the complete loadout's skill requirements. There is no switch to disable this validation.

The Fruma update removed the armour equip-order requirement. For each skill, the allocator sums the bonuses from non-crafted armour/accessories and the selected guild tome. Each piece's own bonus is removed when checking its requirement. Weapon, crafted and set skill bonuses contribute to final skills, but cannot unlock gear requirements. Requirements at or below zero require no allocation.

The allocator finds the minimum manual points satisfying every final requirement, including the weapon. The sum must fit `min(200, 2 × (level − 1))` and each manually allocated skill must be at most 100. The guild tome lowers the necessary manual allocation through its skill bonuses. The guild tome slot requires level 105.

The search accounts for possible support from every future armour/accessory slot when deciding whether a partial branch could work. A piece that is unusable alone can remain a candidate when another piece could make the complete build valid. Both the normal builder and the optimizer call the same allocator.

[Fruma equipment changes](https://wynncraft.wiki.gg/wiki/Version_2.2) · [Skill points](https://wynncraft.wiki.gg/wiki/Skills) · [Skill-point identifications](https://wynncraft.wiki.gg/wiki/Identifications)

## Search metrics and full builder calculations

Filtering and ranking use the native final calculation pipeline, including selected abilities, aspects, raid buffs, Radiance, powder specials, equipped powders and tomes. Available metrics cover the final defense summary, mana totals and mana per hit, utility stats, melee DPS and damage per attack, poison DPS, and spell outputs and mana costs from the selected ability tree. Attack speed uses 0 for Super Slow through 6 for Super Fast. Select the weapon class and ability tree before adding spell targets.

Final and combined metrics are available alongside individual numeric identifications in every target, primary ranking and secondary ranking menu. For example, use **HP Regen (Final)** for the combined result, **HP Regen (Raw)** for the raw component, and **HP Regen %** for its percentage component. All three can be constrained simultaneously. Component values come from the native aggregated calculation state, including active effects; they are measured before the corresponding raw/percentage combination. Menus group health/defense, spell damage, melee damage, general damage, mana/cost components and other identifications. Generic spell hit and actual ability outputs remain available.

The search uses the minimum valid skill allocation and leaves spare points unassigned. Candidate equipment can activate its own major IDs. The selected tree, aspects and interactive settings apply to candidates of the current weapon class. Choosing a different class starts with its default attacks until you configure that class in the editor. Fixed item stats are read from the catalog and cannot be overridden by the roll editor or older share links.

**Generic spell hit** combines raw and percentage damage into an average damage benchmark. It evaluates a 100% spell hit with the equipped weapon's existing elemental distribution and native attack-speed scaling, skill points, critical chance and shared buffs. It excludes individual spell conversions and part-specific multipliers. Actual spells with different conversions, hit counts or scaling can rank differently. Shared damage IDs are also available individually.

Use **Secondary ranking** to add ordered tie breakers. The primary metric has priority, then the first secondary, then subsequent rows. Each can prefer highest or lowest. Secondary scores are displayed on result cards, and settings are remembered locally.

The default **CUDA backend** generates and skill-filters candidate batches on the GPU, then scores a shortlist with up to eight native CPU validators. It uses a fast item-stat proxy and random samples for shortlisting. Your selected final-stat targets, primary ranking and secondary rankings are applied by the native calculator. It runs until stopped. Every returned build is validated, and global optimality is unproven.

The explicit **CPU optimization** mode runs until stopped using up to eight CPU workers. Workers search independently, exchange their strongest builds and make one-piece and multi-piece changes. Near-feasible candidates stay available so a later piece can repair missing skill points or target stats. Returned builds always pass the native final calculations, level/class restrictions, complete-loadout skill requirements and every target. Results use the configured primary and secondary rankings.

Optimization results are the best found so far. They have no global optimality guarantee. Stop the search or apply a result at any time to retain the best builds found so far. Fewer workers can help if memory use or responsiveness becomes an issue. Candidate pools with at most 256 combinations finish exhaustively even in CPU optimization mode.

Choose **CPU exhaustive search** for a full ranking proof over a restricted pool. This mode uses one worker and runs until completion or cancellation. Skill feasibility prunes branches using future equipment support. Bounds for full combat effects remain conservative, so unrestricted exhaustive runs can still take a very long time.

All modes cache ability structure by class and active major IDs within a search. Only spells needed by the targets or rankings are evaluated. Generic spell ranking skips individual spell damage calculations. The CPU modes use browser Web Workers. CUDA mode uses the local backend and native Node worker threads.


The progress panel remains visible after stopping. CUDA displays estimated distinct GPU combinations checked out of the allowed total, alongside raw proposals and native evaluations. Sampling can revisit candidates, so the coverage estimate differs from the raw proposal counter. CUDA batches run continuously while a separate bounded shortlist is evaluated natively. Batch size and native shortlist size can be tuned independently. Full final calculations remain CPU work.

## Candidate JSON

The built-in native database is the default source. Open **Item pool** in **Search settings** and choose **Import candidate JSON** to select a smaller pool. It can be a JSON list of native item names or a WynnBuilder data file containing an `items` array. Official API exports with matching internal names are also accepted. Items missing from the loaded native version are reported before changing the pool.

```json
{
  "items": ["Third Eye", "Aquarius", "Vaward", "Memento", "Concentration", "Prism", "Prowess", "Diamond Hydro Necklace", "Cascade"]
}
```

Imports select native templates from the currently loaded version. Use **Edit rolls** for owned values and the native custom/crafting tools for new gear definitions. An imported pool needs an eligible item for every unlocked slot. Locked items stay eligible even when omitted from the imported list. **Use full database** clears the pool filter.

## Verification

```sh
pnpm install
pnpm test
pnpm test:integration
pnpm build
node tests/native-page.mjs dist
```

The dependency-free core tests cover mutual support, the exclusion of a piece's own bonus, crafted/weapon/set exclusions, guild support, point caps, future support, native roll scenarios and exhaustive rank comparisons. The DOM integration test mounts the actual builder page and its scripts. It checks search and application against the native compute graph, owned zero rolls, share-query preservation and selected guild tome changes. It can run against the generated static site.
