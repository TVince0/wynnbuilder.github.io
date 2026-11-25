# Search strategy and reference projects

## What runs now

The global CUDA generator does not enumerate gear in catalog order. Each fresh slot pick is uniformly random. Normally about 20% of proposals start fresh and 80% use retained parents. Parent offspring can cross over slots and make one, two or four mutation attempts. Small one/two-piece repair tournaments then compare target-oriented estimates. Repeated survivors are deduplicated on the host; high repetition periodically triggers fresh batches. The slot order is a representation, not an equip order.

This has an important limitation: a GPU block reduces 256 proposals to two survivors before host deduplication. Repeated winners can crowd out unseen alternatives. Higher raw GPU throughput alone does not resolve that sampling problem.

Systematic nearby-build repair is enabled by default and runs alongside the global generator:

1. Evaluate compatible saved/current starting builds natively first. Owned locks and imported item pools remain authoritative.
2. For a retained anchor, rank one-piece alternatives by predicted constraint shortfall, then the primary score. Cheap aggregate estimates are calibrated against the anchor's actual native values. Skill support is recomputed across the full candidate loadout.
3. Submit the best 128 single swaps first. Then consider a bounded two-piece neighborhood using per-slot target, skill-support and score alternatives. At most 2,048 paired proposals are retained before continuing with other single swaps.
4. Native validation checks every selected candidate. A normal cycle reserves up to half its shortlist for systematic neighbors and keeps global GPU proposals in the remainder.
5. Improved anchors start new neighborhoods. Seen tuples, bounded queues and recent-anchor history prevent repeatedly walking the same neighborhood. The recent-anchor history rolls gradually, so it does not impose a lifetime expansion stop.

Each anchor retains at most 8,192 neighbors. Very large pools sample at most about 1,500 alternatives per slot for local ordering. All candidates remain available to global GPU exploration. These are heuristic limits, not exhaustive proofs or permanent item pruning.

The public closest attempt is always a skill-valid, fully native-scored build. It can miss stat targets, but cannot exceed the point budget or per-skill cap. If no skill-valid build has been scored, the public closest field is empty. Internal infeasible parents are separate: their aggregate guidance is marked `skill-only`, and they never receive full ability-graph evaluation or become applicable results.

## Repairing shared builds

Open **Repair shared builds / starting builds** and load a WynnBuilder share link. The link's hash is loaded through the existing native decoder on this local site, including legacy data-version handling, abilities, aspects and powders. Only the build/version/roll parameters are forwarded; the external host is not loaded.

The source equipment is saved as a starting example. Existing owned locks, their actual rolls, targets, rankings and the imported item pool are preserved. Up to eight examples are retained locally. Only examples matching the selected class and loaded data version are used. Starting examples contain gear identities and item-stat features; the current editor's ability/buff context applies to every candidate in a search.

Select restrictions as needed:

- **No guild tome** clears the native guild selector before evaluating or applying a search. The backend also removes guild tomes from the prepared request, so skill validity cannot depend on a hidden guild bonus.
- **Exclude crafted gear** filters crafted candidates. A conflicting crafted lock is rejected with a request to unlock it. An unlocked source piece absent from the eligible pool is replaced by a nearby eligible template for initialization.
- **Require HP Regen (Final) ≥ 0** adds a native final-regen bound. An existing stricter regen minimum is preserved.

These examples provide warm starts and useful multi-item combinations; they are not treated as verified answers. Guild-dependent, crafted or negative-regen source builds may initially be infeasible under the new restrictions. Only repaired candidates passing all current checks enter results.

## Lessons from other projects

Reviewed 2026-11-25 against project-owned documentation/source:

- [Raidbots Smart Sim](https://support.raidbots.com/article/55-smart-sim) uses low-precision simulations to eliminate weak configurations before spending higher-precision work on survivors. WynnBuilder's deterministic formulas do not have the same Monte Carlo error margins. The applicable lesson is staged work: cheap feasibility/guidance first, full calculations for candidates that can qualify.
- [Path of Building's TradeQueryGenerator](https://github.com/PathOfBuildingCommunity/PathOfBuilding/blob/dev/src/Classes/TradeQueryGenerator.lua) evaluates individual modifiers using its own calculation engine, normalizes output changes into weights, caches repeated modifier work and yields periodically. The inspected `GenerateModWeights` implementation is around lines 563–608; `RequestQuery` constructs its calculation context around lines 768–785. The applicable lesson is build-specific marginal value and native validation, rather than one permanent global gear ranking. Our local residual guidance is an approximation, not a port of PoB's weighting formula.
- [Ask Mr. Robot's own architecture article](https://www.askmrrobot.com/articles/a-new-kind-of-simulator) describes automatic search-space pruning and fast configuration scoring, and explicitly keeps important implementation details proprietary. Its public claims do not establish a particular genetic, branch-and-bound or learned-model algorithm that we can copy. The applicable lesson is reducing expensive evaluations without requiring the user to hand-select the answer.

## Further improvements worth prioritizing

1. **Spare skill-point optimization.** The current evaluator uses the minimum required manual allocation. It leaves remaining points unassigned. This can miss otherwise legal candidates that would meet mana/damage/survivability targets after distributing those points. Jointly optimizing the allocation is a separate missing search dimension; it must be reflected in native scoring, validity checks, result application and sharing.
2. **GPU-side novelty before block reduction.** Feed a bounded recent-state table back to the device, so familiar survivors do not suppress unseen runner-up candidates. Hash collisions must not be used as an exhaustive infeasibility proof. Transfer and lookup costs need hardware measurements.
3. **Adaptive local beam sizes and neighborhood budgets.** Allocate more effort to neighborhoods producing better native states, reduce work on stagnant ones, and preserve islands for distinct constraint tradeoffs. The present implementation bounds and deduplicates local work but uses fixed per-slot/pair limits.
4. **A learned surrogate from recorded native evaluations.** A model could rank proposals using native-labeled examples, including poor and infeasible cases. Held-out validation, class/version separation and shift detection would be necessary. Full native checks should remain the acceptance authority.

Set effects, major IDs, negative IDs, upper bounds and mutually supporting requirements make naive per-item dominance pruning unsafe. A permanent pruning rule must preserve all relevant interactions; heuristic shortlists should retain exploration outside their top-ranked region.

No global-optimality or no-solution guarantee follows from the GPU coverage percentage, the local neighborhoods or a trained ranking model. Actual throughput depends on the device, selected native tree and candidate pool. Development tests cover uniqueness, coupled skill repairs, exclusions, shared-link loading and native result parity; they do not substitute for profiling on the user's GPU.
