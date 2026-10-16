/** Id as a string; a missing id (null/undefined) is "" — never the text "undefined". */
function idString(value: unknown): string {
  return value == null ? "" : String(value);
}

export function mapProductionOrder(p: Record<string, unknown>) {
  const plannedLines = Array.isArray(p.plannedLines)
    ? (p.plannedLines as Record<string, unknown>[]).map((l) => ({
        ...l,
        productId: idString(l.productId),
      }))
    : [];

  const consumption = Array.isArray(p.consumption)
    ? (p.consumption as Record<string, unknown>[]).map((c) => ({
        ...c,
        productId: idString(c.productId),
        batches: Array.isArray(c.batches)
          ? (c.batches as Record<string, unknown>[]).map((b) => ({
              ...b,
              layerId: idString(b.layerId),
              purchaseDate: b.purchaseDate
                ? new Date(b.purchaseDate as string).toISOString().slice(0, 10)
                : undefined,
            }))
          : [],
      }))
    : [];

  const batch = p.batch as Record<string, unknown> | null | undefined;
  const mappedBatch = batch
    ? {
        ...batch,
        outputProductId: idString(batch.outputProductId),
        fifoLayerId: batch.fifoLayerId ? String(batch.fifoLayerId) : undefined,
        producedAt: batch.producedAt
          ? new Date(batch.producedAt as string).toISOString().replace("T", " ").slice(0, 16)
          : undefined,
      }
    : null;

  return {
    ...p,
    formulaId: idString(p.formulaId),
    oilProductId: p.oilProductId ? String(p.oilProductId) : undefined,
    outputProductId: idString(p.outputProductId),
    plannedLines,
    consumption,
    batch: mappedBatch,
    completedAt: p.completedAt
      ? new Date(p.completedAt as string).toISOString().replace("T", " ").slice(0, 16)
      : undefined,
    cancelledAt: p.cancelledAt
      ? new Date(p.cancelledAt as string).toISOString().replace("T", " ").slice(0, 16)
      : undefined,
    createdAt: p.createdAt
      ? new Date(p.createdAt as string).toISOString().replace("T", " ").slice(0, 16)
      : undefined,
    updatedAt: p.updatedAt
      ? new Date(p.updatedAt as string).toISOString().slice(0, 10)
      : undefined,
  };
}
