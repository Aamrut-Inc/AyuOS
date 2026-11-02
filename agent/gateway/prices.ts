// USD per million tokens (input, output), for the cost log and the per-turn
// cost cap. Claude prices are the published ones (checked 2026-11-01). Other
// models have no built-in price: set them in the assistant's settings
// (`model_prices`); until then their cost is logged as 0 and the per-turn
// token cap is what limits a runaway turn.
const BUILT_IN: Record<string, [number, number]> = {
  "claude-fable-5-1": [10, 50],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "claude-sonnet-5-5": [2, 10],
  "claude-sonnet-5": [2, 10],
  "claude-haiku-5-5": [0.1, 0.5]
};

let overrides: Record<string, [number, number]> = {};

export function setPriceOverrides(prices: Record<string, [number, number]>): void {
  overrides = prices ?? {};
}

export function priceKnown(model: string): boolean {
  return Boolean(overrides[model] ?? BUILT_IN[model]);
}

export function costUsd(model: string, inputTokens: number, outputTokens: number): number {
  const price = overrides[model] ?? BUILT_IN[model] ?? Object.entries(overrides).find(([k]) => model.startsWith(k))?.[1];
  if (!price) return 0;
  return (inputTokens * price[0] + outputTokens * price[1]) / 1_000_000;
}
