import { Types } from "mongoose";
import { connectDB } from "@/lib/db";
import { Product, Sale } from "@/lib/models";
import { registerReport } from "../registry";
import type { ReportRow } from "../types";

/**
 * RPT-02: sold quantity/revenue per product, with category and brand.
 * Revenue is net of discounts (POS-073): the line's own discount, plus its
 * share of the bill discount pro rata to line value — so the report total
 * matches what the profit report and cash closing count.
 */
registerReport({
  id: "sales-by-product",
  label: "Sales by product",
  description: "Quantity sold and revenue per product, with category and brand.",
  category: "sales",
  branchScoped: true,
  columns: [
    { key: "product", label: "Product", type: "string" },
    { key: "category", label: "Category", type: "string" },
    { key: "brand", label: "Brand", type: "string" },
    { key: "qty", label: "Qty sold", type: "number" },
    { key: "revenue", label: "Revenue", type: "currency" },
  ],
  async run(_ctx, filters) {
    await connectDB();

    const match: Record<string, unknown> = {
      status: "completed",
      createdAt: { $gte: filters.from, $lte: filters.to },
    };
    if (filters.branchId && Types.ObjectId.isValid(filters.branchId)) {
      match.branchId = new Types.ObjectId(filters.branchId);
    }

    const lineNet = {
      $subtract: [
        { $multiply: ["$$l.qty", "$$l.unitPrice"] },
        { $ifNull: ["$$l.discountAmount", 0] },
      ],
    };
    const grouped = await Sale.aggregate([
      { $match: match },
      {
        $addFields: {
          linesNet: { $sum: { $map: { input: "$lines", as: "l", in: lineNet } } },
        },
      },
      { $unwind: "$lines" },
      {
        $addFields: {
          lineRevenue: {
            $let: {
              vars: {
                net: {
                  $subtract: [
                    { $multiply: ["$lines.qty", "$lines.unitPrice"] },
                    { $ifNull: ["$lines.discountAmount", 0] },
                  ],
                },
                bill: { $ifNull: ["$invoiceDiscountAmount", 0] },
              },
              in: {
                $subtract: [
                  "$$net",
                  {
                    $cond: [
                      { $gt: ["$linesNet", 0] },
                      { $divide: [{ $multiply: ["$$bill", "$$net"] }, "$linesNet"] },
                      0,
                    ],
                  },
                ],
              },
            },
          },
        },
      },
      {
        $lookup: {
          from: Product.collection.name,
          localField: "lines.productId",
          foreignField: "_id",
          as: "product",
        },
      },
      { $unwind: { path: "$product", preserveNullAndEmptyArrays: true } },
      {
        $group: {
          _id: "$lines.name",
          category: { $first: "$product.category" },
          brand: { $first: "$product.brand" },
          qty: { $sum: "$lines.qty" },
          revenue: { $sum: "$lineRevenue" },
        },
      },
      { $sort: { revenue: -1 } },
    ]);

    const rows: ReportRow[] = grouped.map((g) => ({
      product: g._id || "Unnamed item",
      category: g.category || "—",
      brand: g.brand || "—",
      qty: Math.round(g.qty * 100) / 100,
      revenue: Math.round(g.revenue * 100) / 100,
    }));

    const totals = {
      qty: Math.round(rows.reduce((s, r) => s + Number(r.qty || 0), 0) * 100) / 100,
      revenue: Math.round(rows.reduce((s, r) => s + Number(r.revenue || 0), 0) * 100) / 100,
    };

    return { rows, totals };
  },
});
