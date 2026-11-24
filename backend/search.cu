// CUDA proposal search. Only complete-loadout skill feasibility is a hard GPU filter.
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
                                  int objective, int direction, double &score) {
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
    double assigned = 0;
    for (int k = 0; k < 5; ++k) {
        if (manual[k] > 100) return false;
        assigned += manual[k]; total[k] += manual[k];
    }
    if (assigned > budget) return false;
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
    return isfinite(score);
}

#ifndef WYNN_HOST_TEST
__device__ unsigned long long mix_hash(unsigned long long value) {
    value = (value ^ (value >> 30)) * 0xbf58476d1ce4e5b9ULL;
    value = (value ^ (value >> 27)) * 0x94d049bb133111ebULL;
    return value ^ (value >> 31);
}

extern "C" __global__ void propose(const double *items, const int *offsets,
                                   const int *sizes, const double *base,
                                   const int *elites, int elite_count,
                                   int budget, int objective, int direction,
                                   int duplicate_rings, const int *ring_ids,
                                   uint seed, int *output, uint *valid_count,
                                   double *output_scores, uint *coverage, int symmetric_rings) {
    const int lane = threadIdx.x;
    const int id = blockIdx.x * blockDim.x + lane;
    uint rng = seed ^ ((uint)id * 747796405u + 2891336453u);
    if (!rng) rng = 1;
    int indices[9];
    bool from_elite = elite_count > 0 && next_random(rng) % 100 >= 20;
    const int parent = elite_count ? next_random(rng) % elite_count : 0;
    const int other = elite_count ? next_random(rng) % elite_count : 0;
    for (int slot = 0; slot < 9; ++slot) {
        const int chosen = (next_random(rng) % 100 < 25) ? other : parent;
        indices[slot] = from_elite ? elites[chosen*9+slot]
                                  : offsets[slot] + next_random(rng) % sizes[slot];
    }
    if (from_elite) {
        const uint roll = next_random(rng) % 100;
        const int changes = roll < 55 ? 1 : roll < 85 ? 2 : 4;
        for (int move = 0; move < changes; ++move) {
            const int slot = next_random(rng) % 9;
            indices[slot] = offsets[slot] + next_random(rng) % sizes[slot];
        }
    }
    double score = -1.0e300;
    const bool legal_rings = duplicate_rings || ring_ids[indices[4]] != ring_ids[indices[5]];
    if (legal_rings) {
        unsigned long long hash = 0x6a09e667f3bcc909ULL;
        int first_ring = indices[4] - offsets[4], second_ring = indices[5] - offsets[5];
        if (symmetric_rings && first_ring > second_ring) {
            int temporary = first_ring; first_ring = second_ring; second_ring = temporary;
        }
        for (int slot = 0; slot < 9; ++slot) {
            const int local = slot == 4 ? first_ring : slot == 5 ? second_ring : indices[slot] - offsets[slot];
            hash = mix_hash(hash ^ ((unsigned long long)local + ((unsigned long long)slot << 32)));
        }
        const uint bucket = hash & 16383ULL;
        const uint rank = (uint)(__clzll(hash >> 14) - 13);
        atomicMax(coverage + bucket, rank);
    }
    const bool valid = legal_rings && evaluate_candidate(items, indices, base, budget, objective, direction, score);
    if (valid) atomicAdd(valid_count, 1u);
    __shared__ double scores[LANES];
    __shared__ double original_scores[LANES];
    __shared__ uint tickets[LANES];
    __shared__ int best_lane[LANES];
    __shared__ int random_lane[LANES];
    __shared__ int choices[LANES*9];
    scores[lane] = valid ? score : -1.0e300;
    original_scores[lane] = scores[lane];
    tickets[lane] = valid ? (next_random(rng) | 1u) : 0;
    best_lane[lane] = lane; random_lane[lane] = lane;
    for (int k = 0; k < 9; ++k) choices[lane*9+k] = indices[k];
    __syncthreads();
    for (int stride = LANES/2; stride; stride /= 2) {
        if (lane < stride) {
            if (scores[lane+stride] > scores[lane]) {
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
    }
    // Keep both a proxy winner and an unbiased valid sample from each block.
    if (lane < 9) {
        const int out = blockIdx.x * 18 + lane;
        output[out] = tickets[0] ? choices[best_lane[0]*9+lane] : -1;
        output[out+9] = tickets[0] ? choices[random_lane[0]*9+lane] : -1;
    }
}

#endif
