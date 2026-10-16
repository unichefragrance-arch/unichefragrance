import mongoose from "mongoose";
import { Product } from "@/lib/models";

/**
 * Ordered and received quantities must fit the product's unit: pieces are
 * whole numbers (sales, adjustments and transfers already refuse fractional
 * pcs), so a receipt of 2.5 pcs would leave half a unit that can never be sold.
 * Returns an error message, or null when every line fits.
 */
export async function purchaseLineUnitError(
  lines: Array<{ productId?: unknown; productName?: string; qtyOrdered?: number; qtyReceived?: number }>,
): Promise<string | null> {
  const ids = [...new Set(lines.map((l) => String(l.productId)).filter((id) => mongoose.isValidObjectId(id)))];
  if (ids.length === 0) return null;
  const units = new Map(
    (await Product.find({ _id: { $in: ids } }).select("unit name").lean<{ _id: unknown; unit?: string; name: string }[]>())
      .map((p) => [String(p._id), p]),
  );
  for (const line of lines) {
    const product = units.get(String(line.productId));
    if ((product?.unit ?? "pcs") !== "pcs") continue;
    for (const [label, value] of [["ordered", line.qtyOrdered], ["received", line.qtyReceived]] as const) {
      const qty = Number(value ?? 0);
      if (!Number.isInteger(qty)) {
        return `${product?.name ?? line.productName ?? "Product"}: ${label} quantity must be a whole number of pieces (got ${qty})`;
      }
    }
  }
  return null;
}
