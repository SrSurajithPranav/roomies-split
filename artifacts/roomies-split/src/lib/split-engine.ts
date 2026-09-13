export type SplitItem = {
  id: string;
  quantity: number;
  totalPrice: number;
  unitPrice: number;
  discount: number;
  tax: number;
};

export type SplitPerson = { id: string; name: string; color: string };

export type SplitAllocation = {
  itemId: string;
  mode: "equal" | "percentage" | "quantity";
  personId: string;
  quantity: number;
  percentage: number;
};

export type SplitAdjustments = {
  subtotal: number;
  discount: number;
  cgst: number;
  sgst: number;
  igst: number;
  otherCharges: number;
  roundOff: number;
  grandTotal: number;
};

export type SplitShare = { person: SplitPerson; amount: number };

const toCents = (value: number) => Math.round((value + Number.EPSILON) * 100);
const fromCents = (value: number) => value / 100;

function allocateCents(totalCents: number, weights: number[]) {
  if (totalCents <= 0 || weights.length === 0) return weights.map(() => 0);
  const totalWeight = weights.reduce((sum, weight) => sum + Math.max(0, weight), 0);
  if (!totalWeight) return weights.map(() => 0);

  const exact = weights.map((weight) => (totalCents * Math.max(0, weight)) / totalWeight);
  const allocated = exact.map(Math.floor);
  let remainder = totalCents - allocated.reduce((sum, amount) => sum + amount, 0);
  const byLargestRemainder = exact
    .map((amount, index) => ({ index, remainder: amount - Math.floor(amount) }))
    .sort((a, b) => b.remainder - a.remainder || a.index - b.index);
  for (const entry of byLargestRemainder) {
    if (remainder <= 0) break;
    allocated[entry.index] += 1;
    remainder -= 1;
  }
  return allocated;
}

function allocateSignedCents(totalCents: number, weights: number[]) {
  const sign = totalCents < 0 ? -1 : 1;
  return allocateCents(Math.abs(totalCents), weights).map((amount) => amount * sign);
}

export function calculateSplit(
  items: SplitItem[],
  people: SplitPerson[],
  allocations: SplitAllocation[],
  adjustments: SplitAdjustments,
) {
  const itemCents = items.map((item) =>
    toCents(
      item.totalPrice ||
        Math.max(0, item.quantity * item.unitPrice - item.discount + item.tax),
    ),
  );
  const baseShares = people.map(() => 0);

  items.forEach((item, itemIndex) => {
    const itemAllocations = allocations.filter(
      (allocation) => allocation.itemId === item.id,
    );
    const participantIndexes = itemAllocations
      .map((allocation) => people.findIndex((person) => person.id === allocation.personId))
      .filter((index) => index >= 0);
    if (!participantIndexes.length) return;

    const weights = itemAllocations.map((allocation) => {
      if (allocation.mode === "quantity") return Math.max(0, allocation.quantity);
      if (allocation.mode === "percentage") return Math.max(0, allocation.percentage);
      return 1;
    });
    const shares = allocateCents(itemCents[itemIndex], weights);
    itemAllocations.forEach((allocation, allocationIndex) => {
      const personIndex = people.findIndex((person) => person.id === allocation.personId);
      if (personIndex >= 0) baseShares[personIndex] += shares[allocationIndex];
    });
  });

  const subtotalCents = itemCents.reduce((sum, cents) => sum + cents, 0);
  const targetCents = Math.max(
    0,
    subtotalCents -
      toCents(adjustments.discount) +
      toCents(adjustments.cgst) +
      toCents(adjustments.sgst) +
      toCents(adjustments.igst) +
      toCents(adjustments.otherCharges) +
      toCents(adjustments.roundOff),
  );
  const adjustmentCents = targetCents - baseShares.reduce((sum, cents) => sum + cents, 0);
  const adjustmentWeights = baseShares.some((share) => share > 0)
    ? baseShares
    : people.map(() => 1);
  const adjustmentShares = allocateSignedCents(adjustmentCents, adjustmentWeights);
  const finalShares = baseShares.map((share, index) => share + adjustmentShares[index]);

  return {
    subtotal: fromCents(subtotalCents),
    grandTotal: fromCents(targetCents),
    shares: people.map((person, index) => ({
      person,
      amount: fromCents(finalShares[index]),
    })),
  };
}