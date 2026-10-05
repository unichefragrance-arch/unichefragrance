import { roundMoney } from "@/lib/money";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { PurchaseOrder } from "@/lib/models";
import {
  applyFifoFromPurchase,
  derivePurchaseStatus,
  syncReceivedQtys,
} from "@/lib/purchases/applyFifoFromPurchase";
import { recalcSupplierAvgLeadDays } from "@/lib/purchases/supplierLeadTime";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { branchScopeFilter } from "@/lib/auth/guards";
import { recordAudit } from "@/lib/audit/log";

function mapLine(l: Record<string, unknown>) {
  return {
    ...l,
    id: String(l.id ?? l._id ?? ""),
    productId: String(l.productId),
  };
}

function mapPO(p: Record<string, unknown>) {
  const lines = Array.isArray(p.lines) ? p.lines.map((l) => mapLine(l as Record<string, unknown>)) : [];
  return {
    ...p,
    supplierId: String(p.supplierId),
    date: p.date ? new Date(p.date as string).toISOString().slice(0, 10) : null,
    lines,
  };
}

type LineBody = {
  productId: string;
  productName?: string;
  sku?: string;
  qtyOrdered?: number;
  qty?: number;
  qtyReceived?: number;
  unitCost?: number;
};

function normalizeLines(raw: LineBody[] | undefined) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((l) => {
      const qtyOrdered = Number(l.qtyOrdered ?? l.qty ?? 0);
      return {
        productId: String(l.productId),
        productName: String(l.productName || "").trim() || "Product",
        sku: String(l.sku || ""),
        qtyOrdered,
        qtyReceived: Number(l.qtyReceived ?? 0),
        qtyFifoApplied: 0,
        unitCost: Number(l.unitCost ?? 0),
      };
    })
    .filter((l) => l.productId && l.qtyOrdered > 0);
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const filter: Record<string, unknown> = {};
    if (access) {
      const scope = branchScopeFilter(access);
      if (scope) Object.assign(filter, scope);
    }
    const purchases = await PurchaseOrder.find(filter).sort({ date: -1 });
    return NextResponse.json(toJSONList(purchases).map(mapPO));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load purchases") },
      { status: 500 },
    );
  }
}

export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = await req.json();
    const lines = normalizeLines(body.lines);
    let status = (body.status as string) || "draft";

    syncReceivedQtys(lines, status);
    if (lines.length) {
      status = derivePurchaseStatus(lines, status as "draft" | "ordered" | "received" | "partial");
    }

    const subtotal =
      lines.length > 0
        ? lines.reduce((s, l) => s + l.qtyOrdered * l.unitCost, 0)
        : Number(body.subtotal ?? body.total ?? 0);
    const itemCount = lines.length > 0 ? lines.length : Number(body.itemCount || 0);
    const vatPercent = Math.max(0, Number(body.vatPercent ?? 5));
    const vatAmount = roundMoney(subtotal * (vatPercent / 100));
    const total = roundMoney(subtotal + vatAmount);

    const purchase = await PurchaseOrder.create({
      supplierId: body.supplierId,
      supplierName: body.supplierName,
      currency: body.currency || "OMR",
      notes: body.notes,
      date: new Date(body.date || Date.now()),
      status,
      subtotal,
      vatPercent,
      vatAmount,
      total,
      itemCount,
      lines,
      branchId: access?.branchId ?? undefined,
      branchName: access?.branchName ?? undefined,
    });

    // Goods receipt → FIFO layers + costFifo refresh (via addFifoLayer)
    if (status === "received" || status === "partial") {
      await applyFifoFromPurchase(purchase);
      purchase.markModified("lines");
    }
    // PUR-12: first time a PO lands fully received, stamp it and refresh supplier lead time.
    if (status === "received" && !purchase.receivedAt) {
      purchase.receivedAt = new Date();
    }
    if (purchase.isModified()) {
      await purchase.save();
    }
    if (status === "received") {
      void recalcSupplierAvgLeadDays(String(purchase.supplierId));
    }

    recordAudit({
      session: access,
      action: "purchase_created",
      entityType: "PurchaseOrder",
      entityId: String(purchase._id),
      detail: `${purchase.supplierName || ""} · ${purchase.total}`,
      req,
    });

    return NextResponse.json(mapPO(toJSON(purchase)!), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create purchase") },
      { status: 400 },
    );
  }
}
