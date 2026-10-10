/** Sort by real tokenizer lengths, cap both padding and item count, preserve source indices. */
export function tokenBatches(lengths: number[], budget = 6000, maxItems = 32): number[][] {
  const order = lengths.map((_, i) => i).sort((a, b) => lengths[a] - lengths[b]);
  const batches: number[][] = [];
  let batch: number[] = [];
  for (const i of order) {
    if (batch.length && (batch.length >= maxItems || (batch.length + 1) * lengths[i] > budget)) {
      batches.push(batch); batch = [];
    }
    batch.push(i);
  }
  if (batch.length) batches.push(batch);
  return batches;
}
