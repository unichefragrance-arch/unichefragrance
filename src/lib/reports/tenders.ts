import type { PipelineStage } from "mongoose";
import { roundMoney } from "@/lib/money";
import { Sale } from "@/lib/models";

export type Tender = "cash" | "card" | "bank" | "credit" | "mixed";

export type TenderTotals = {
  /** Every completed sale, however it was paid. */
  grossSales: number;
  saleCount: number;
  /** Amount and number of sales per tender. Mixed sales are split into their parts. */
  byTender: Record<Tender, { amount: number; count: number }>;
};

/**
 * Sales money by tender over `match` (a Sale filter). A mixed sale counts
 * each part of its paymentBreakdown under its own method, so the cash part
 * lands in "cash"; "mixed" only holds legacy mixed sales with no breakdown.
 * Credit is a receivable, not money collected.
 */
export async function salesByTender(match: Record<string, unknown>): Promise<TenderTotals> {
  const pipeline: PipelineStage[] = [
    // Aggregation skips schema casting — cast the filter exactly as find() does.
    { $match: Sale.find(match).cast(Sale) },
    {
      $project: {
        total: { $ifNull: ["$total", 0] },
        tenders: {
          $cond: [
            {
              $and: [
                { $eq: ["$payment", "mixed"] },
                { $gt: [{ $size: { $ifNull: ["$paymentBreakdown", []] } }, 0] },
              ],
            },
            "$paymentBreakdown",
            [{ method: { $ifNull: ["$payment", "cash"] }, amount: { $ifNull: ["$total", 0] } }],
          ],
        },
      },
    },
    {
      $facet: {
        gross: [{ $group: { _id: null, amount: { $sum: "$total" }, count: { $sum: 1 } } }],
        tenders: [
          { $unwind: "$tenders" },
          { $group: { _id: "$tenders.method", amount: { $sum: "$tenders.amount" }, count: { $sum: 1 } } },
        ],
      },
    },
  ];
  const [res] = await Sale.aggregate<{
    gross: { amount: number; count: number }[];
    tenders: { _id: string; amount: number; count: number }[];
  }>(pipeline);

  const byTender: TenderTotals["byTender"] = {
    cash: { amount: 0, count: 0 },
    card: { amount: 0, count: 0 },
    bank: { amount: 0, count: 0 },
    credit: { amount: 0, count: 0 },
    mixed: { amount: 0, count: 0 },
  };
  for (const t of res?.tenders ?? []) {
    const key = (t._id in byTender ? t._id : "mixed") as Tender;
    byTender[key].amount = roundMoney(byTender[key].amount + t.amount);
    byTender[key].count += t.count;
  }
  return {
    grossSales: roundMoney(res?.gross[0]?.amount ?? 0),
    saleCount: res?.gross[0]?.count ?? 0,
    byTender,
  };
}
