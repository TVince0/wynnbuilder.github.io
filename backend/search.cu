// Constraint-guided CUDA proposals. Native evaluation validates every returned build.
// Final combat scores and target checks are performed by the native WynnBuilder evaluator.
#define WIDTH 32
#define LANES 256

typedef unsigned int uint;
__device__ uint next_random(uint &state) {
    state ^= state << 13; state ^= state >> 17; state ^= state << 5;
    return state;
}
__device__ double skill_fraction(double points) {
    if (points <= 0) return 0;
    points = fmin(points, 150.0);
    return (0.9908 / (1.0 - 0.9908) * (1.0 - pow(0.9908, points))) / 100.0;
}
// Row layout: bonuses[5], requirements[5], supports, HP, HPR raw, HPR %,
// spell raw, spell %, damage raw, damage %, MR, MS, weapon base DPS,
// objective raw, max mana, elemental defenses[5], crafted unused padding[4].
__device__ bool evaluate_candidate(const double *items, const int *indices,
                                  const double *base, int budget,
                                  int objective, int direction, double &score,
                                  double *summary = 0, double *skills = 0, double *skill_error = 0) {
    double support[5], total[5], manual[5] = {0, 0, 0, 0, 0};
    for (int k = 0; k < 5; ++k) { support[k] = base[k]; total[k] = base[5+k]; }
    double stats[WIDTH] = {0};
    for (int j = 11; j < WIDTH; ++j) stats[j] = base[15+j];
    for (int slot = 0; slot < 9; ++slot) {
        const double *item = items + indices[slot] * WIDTH;
        for (int k = 0; k < 5; ++k) {
            total[k] += item[k];
            if (slot != 8 && item[10] != 0) support[k] += item[k];
        }
        for (int j = 11; j < WIDTH; ++j) stats[j] += item[j];
    }
    for (int slot = 0; slot < 9; ++slot) {
        const double *item = items + indices[slot] * WIDTH;
        for (int k = 0; k < 5; ++k) {
            if (item[5+k] <= 0) continue;
            const double own = slot != 8 && item[10] != 0 ? item[k] : 0;
            manual[k] = fmax(manual[k], ceil(item[5+k] - support[k] + own - 1e-9));
        }
    }
    // A guild tome cannot satisfy its own requirements either.
    for (int k = 0; k < 5; ++k) {
        if (base[10+k] > 0) manual[k] = fmax(manual[k], ceil(base[10+k] - support[k] + base[k] - 1e-9));
    }
    double assigned = 0, excess = 0;
    for (int k = 0; k < 5; ++k) {
        excess += fmax(0.0, manual[k] - 100);
        assigned += manual[k]; total[k] += manual[k];
    }
    excess += fmax(0.0, assigned - budget);
    const double generic = fmax(0.0, stats[20] * (1 + (stats[15] + stats[17]) / 100.0)
                                          + stats[14] + stats[16])
                         * (1 + skill_fraction(total[0]) + skill_fraction(total[1]));
    const double health = fmax(5.0, stats[11]);
    const double regen = stats[12] >= 0
        ? stats[12] * fmax(0.0, 1 + stats[13]/100.0)
        : stats[12] * (1 + fabs(stats[13])/100.0);
    switch (objective) {
        case 1: score = generic; break;
        case 2: score = health; break;
        case 3: score = regen; break;
        case 4: score = health / fmax(0.02, (1-skill_fraction(total[3])*.867)
                                                       * (1-skill_fraction(total[4])*.951)); break;
        case 5: score = stats[21] - skill_fraction(total[2]) * 100.0; break;
        case 6: score = 100 + stats[22] + floor(skill_fraction(total[2])*100); break;
        default: score = stats[21];
    }
    score *= direction;
    if (summary) {
        for (int k = 0; k < WIDTH; ++k) summary[k] = stats[k];
        summary[28] = generic; summary[29] = regen; summary[30] = health; summary[31] = assigned;
    }
    if (skills) for (int k = 0; k < 5; ++k) skills[k] = total[k];
    if (skill_error) *skill_error = excess / fmax(1.0, (double)budget);
    return excess <= 0 && isfinite(score);
}

// Generic elemental damage proxy with the weapon's native distribution. It
// includes raw/percentage IDs, elemental skill boosts and expected crit damage.
// Candidate-dependent sets, abilities and multiplicative buffs stay native.
#define COMBAT_WIDTH 42
__device__ double generic_damage(const double *combat, const double *combat_base, const int *indices, const double *skills) {
    double data[COMBAT_WIDTH];
    for (int k = 0; k < COMBAT_WIDTH; ++k) data[k] = combat_base[k];
    for (int slot = 0; slot < 9; ++slot)
        for (int k = 0; k < COMBAT_WIDTH; ++k) data[k] += combat[indices[slot]*COMBAT_WIDTH+k];
    double minimum[6], maximum[6], total_min = 0, total_max = 0;
    bool present[6];
    for (int e = 0; e < 6; ++e) {
        present[e] = data[e*6] != 0 || data[e*6+1] != 0;
        minimum[e] = data[e*6] + (present[e] ? data[e*6+2] : 0);
        maximum[e] = data[e*6+1] + (present[e] ? data[e*6+3] : 0);
        total_min += minimum[e]; total_max += maximum[e];
    }
    const double elem_min = total_min - minimum[0], elem_max = total_max - maximum[0];
    const double multipliers[5] = {1, 1, 1, .867, .951};
    double result = 0;
    for (int e = 0; e < 6; ++e) {
        const double boost = 1 + data[39]/100 + data[e*6+4]/100 + (e ? data[36]/100 + skill_fraction(skills[e-1])*multipliers[e-1] : 0);
        double raw_min = present[e] ? data[e*6+5] : 0, raw_max = raw_min;
        if (total_max > 0) {
            raw_min += (total_min == 0 ? maximum[e]/total_max : minimum[e]/total_min)*data[40];
            raw_max += maximum[e]/total_max*data[40];
        }
        if (e && elem_max > 0) {
            raw_min += (elem_min == 0 ? maximum[e]/elem_max : minimum[e]/elem_min)*data[37];
            raw_max += maximum[e]/elem_max*data[37];
        }
        result += (fmax(0.0, minimum[e]*boost+raw_min) + fmax(0.0, maximum[e]*boost+raw_max))*.5;
    }
    return result*(1+skill_fraction(skills[0])+skill_fraction(skills[1])*(1+data[38]/100));
}

// Rule layout: derived kind (zero = additive feature), lower, upper, scale.
// Errors are soft guidance: native effects can change every stat in this proxy.
__device__ bool evaluate_guided(const double *items, const int *indices,
                               const double *base, int budget, int objective, int direction,
                               const double *features, const double *rule_base, const double *rules,
                               int rule_count, double &score, double &error, const double *combat = 0, const double *combat_base = 0, double *global_error = 0, int focus = -1) {
    double stats[WIDTH], skills[5], skill_error;
    const bool skill_valid = evaluate_candidate(items, indices, base, budget, objective, direction, score, stats, skills, &skill_error);
    bool needs_damage = objective == 1;
    for (int r = 0; r < rule_count; ++r) if ((int)rules[r*4] == 1) needs_damage = true;
    if (combat && needs_damage) {
        stats[28] = generic_damage(combat, combat_base, indices, skills);
        if (objective == 1) score = stats[28]*direction;
    }
    error = skill_error;
    double total_error = skill_error;
    for (int r = 0; r < rule_count; ++r) {
        const double *rule = rules + r * 4;
        const int kind = (int)rule[0];
        double value = 0;
        if (kind == 0) {
            value = rule_base[r];
            for (int slot = 0; slot < 9; ++slot) value += features[indices[slot] * rule_count + r];
        } else if (kind == 1) value = stats[28];
        else if (kind == 2) value = stats[30];
        else if (kind == 3) value = stats[29];
        else if (kind == 4) value = stats[30] / fmax(0.02, (1-skill_fraction(skills[3])*.867) * (1-skill_fraction(skills[4])*.951));
        else if (kind == 6) value = 100 + stats[22] + floor(skill_fraction(skills[2])*100);
        else if (kind == 7) value = stats[18] + 25;
        else if (kind >= 10 && kind <= 14) value = skills[kind - 10];
        else if (kind == 15) value = stats[31];
        const double gap = (fmax(0.0, rule[1] - value) + fmax(0.0, value - rule[2])) / rule[3];
        total_error += gap;
        error += gap * (focus == -2 ? 0.0 : focus < 0 ? 1.0 : focus == r ? 5.0 : .2);
    }
    if (global_error) *global_error = total_error;
    return skill_valid;
}

__device__ bool better(double error, double score, double old_error, double old_score) {
    return error < old_error || (error == old_error && score > old_score);
}

#ifndef WYNN_HOST_TEST
__device__ unsigned long long mix_hash(unsigned long long value) {
    value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31);
}

__device__ bool check_candidate(const double *items, const int *indices, const int *offsets,
                                const double *base, int budget, int objective, int direction,
                                int duplicate_rings, const int *ring_ids, uint *coverage, int symmetric_rings,
                                const double *features, const double *rule_base, const double *rules, int rule_count,
                                double &score, double &error, uint &feasible, const double *combat, const double *combat_base, double &global_error, int focus) {
    if (!duplicate_rings && ring_ids[indices[4]] == ring_ids[indices[5]]) return false;
    unsigned long long hash = 0x6a09e667f3bcc909ULL;
    int first = indices[4] - offsets[4], second = indices[5] - offsets[5];
    if (symmetric_rings && first > second) { int temporary = first; first = second; second = temporary; }
    for (int slot = 0; slot < 9; ++slot) {
        const int local = slot == 4 ? first : slot == 5 ? second : indices[slot] - offsets[slot];
        hash = mix_hash(hash ^ ((unsigned long long)local + ((unsigned long long)slot << 32)));
    }
    atomicMax(coverage + (hash & 16383ULL), (uint)(__clzll(hash >> 14) - 13));
    if (evaluate_guided(items, indices, base, budget, objective, direction, features, rule_base, rules, rule_count, score, error, combat, combat_base, &global_error, focus)) ++feasible;
    return isfinite(score) && isfinite(error);
}

extern "C" __global__ void propose(const double *items, const int *offsets,
                                   const int *sizes, const double *base,
                                   const int *elites, int elite_count,
                                   int budget, int objective, int direction,
                                   int duplicate_rings, const int *ring_ids,
                                   uint seed, int *output, uint *valid_count,
                                   double *output_scores, uint *coverage, int symmetric_rings,
                                   const double *features, const double *rule_base, const double *rules,
                                   int rule_count, double *output_errors, const double *combat, const double *combat_base) {
    const int lane = threadIdx.x;
    const int id = blockIdx.x * blockDim.x + lane;
    uint rng = seed ^ ((uint)id * 747796405u + 2891336453u);
    if (!rng) rng = 1;
    int indices[9], mutable_slots[9], mutable_count = 0;
    for (int slot = 0; slot < 9; ++slot) if (sizes[slot] > 1) mutable_slots[mutable_count++] = slot;
    bool from_elite = elite_count > 0 && next_random(rng) % 100 >= 20;
    const int parent = elite_count ? next_random(rng) % elite_count : 0;
    const int other = elite_count ? next_random(rng) % elite_count : 0;
    for (int slot = 0; slot < 9; ++slot) {
        const int chosen = (next_random(rng) % 100 < 25) ? other : parent;
        indices[slot] = from_elite ? elites[chosen*9+slot]
                                  : offsets[slot] + next_random(rng) % sizes[slot];
    }
    if (from_elite && mutable_count) {
        const uint roll = next_random(rng) % 100;
        const int changes = roll < 55 ? 1 : roll < 85 ? 2 : 4;
        for (int move = 0; move < changes; ++move) {
            const int slot = mutable_slots[next_random(rng) % mutable_count];
            indices[slot] = offsets[slot] + next_random(rng) % sizes[slot];
        }
    }
    double score = -1.0e300, error = 1.0e300, global_error = 1.0e300;
    const int focus = blockIdx.x % 4 == 0 ? -1 : blockIdx.x % 4 == 1 ? -2 : rule_count ? (blockIdx.x / 4) % rule_count : -1;
    uint feasible = 0, tested = 1;
    bool valid = check_candidate(items, indices, offsets, base, budget, objective, direction,
        duplicate_rings, ring_ids, coverage, symmetric_rings, features, rule_base, rules, rule_count, score, error, feasible, combat, combat_base, global_error, focus);
    // Repair most elite offspring with short one/two-piece tournaments. Keep
    // independent random proposals for exploration and coupled skill changes.
    if (from_elite && mutable_count && lane % 4 != 0) {
        for (int attempt = 0; attempt < 3; ++attempt) {
            int trial[9]; for (int slot = 0; slot < 9; ++slot) trial[slot] = indices[slot];
            const int changes = attempt == 2 && mutable_count > 1 ? 2 : 1;
            int previous = -1;
            for (int move = 0; move < changes; ++move) {
                int slot;
                do { slot = mutable_slots[next_random(rng) % mutable_count]; } while (slot == previous);
                previous = slot;
                trial[slot] = offsets[slot] + next_random(rng) % sizes[slot];
            }
            double trial_score = -1.0e300, trial_error = 1.0e300, trial_global = 1.0e300;
            const bool eligible = check_candidate(items, trial, offsets, base, budget, objective, direction,
                duplicate_rings, ring_ids, coverage, symmetric_rings, features, rule_base, rules, rule_count, trial_score, trial_error, feasible, combat, combat_base, trial_global, focus);
            ++tested;
            if (eligible && (!valid || better(trial_error, trial_score, error, score))) {
                valid = true; score = trial_score; error = trial_error; global_error = trial_global;
                for (int slot = 0; slot < 9; ++slot) indices[slot] = trial[slot];
            }
        }
    }
    atomicAdd(valid_count, feasible);
    atomicAdd(valid_count + 1, tested);
    __shared__ double scores[LANES];
    __shared__ double original_scores[LANES];
    __shared__ double errors[LANES];
    __shared__ double original_errors[LANES];
    __shared__ uint tickets[LANES];
    __shared__ int best_lane[LANES];
    __shared__ int random_lane[LANES];
    __shared__ int choices[LANES*9];
    scores[lane] = valid ? score : -1.0e300;
    original_scores[lane] = scores[lane];
    errors[lane] = valid ? error : 1.0e300;
    original_errors[lane] = valid ? global_error : 1.0e300;
    tickets[lane] = valid ? (next_random(rng) | 1u) : 0;
    best_lane[lane] = lane; random_lane[lane] = lane;
    for (int k = 0; k < 9; ++k) choices[lane*9+k] = indices[k];
    __syncthreads();
    for (int stride = LANES/2; stride; stride /= 2) {
        if (lane < stride) {
            if (better(errors[lane+stride], scores[lane+stride], errors[lane], scores[lane])) {
                errors[lane] = errors[lane+stride];
                scores[lane] = scores[lane+stride]; best_lane[lane] = best_lane[lane+stride];
            }
            if (tickets[lane+stride] > tickets[lane]) {
                tickets[lane] = tickets[lane+stride]; random_lane[lane] = random_lane[lane+stride];
            }
        }
        __syncthreads();
    }
    if (lane == 0) {
        output_scores[blockIdx.x * 2] = original_scores[best_lane[0]];
        output_scores[blockIdx.x * 2 + 1] = original_scores[random_lane[0]];
        output_errors[blockIdx.x * 2] = original_errors[best_lane[0]];
        output_errors[blockIdx.x * 2 + 1] = original_errors[random_lane[0]];
    }
    // Keep the closest-to-target winner and an exploratory sample per block.
    if (lane < 9) {
        const int out = blockIdx.x * 18 + lane;
        output[out] = tickets[0] ? choices[best_lane[0]*9+lane] : -1;
        output[out+9] = tickets[0] ? choices[random_lane[0]*9+lane] : -1;
    }
}

#endif
