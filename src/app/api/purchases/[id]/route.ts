import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { PurchaseOrder } from "@/lib/models";
import {
  applyFifoFromPurchase,
  derivePurchaseStatus,
  syncReceivedQtys,
} from "@/lib/purchases/applyFifoFromPurchase";
import { recalcSupplierAvgLeadDays } from "@/lib/purchases/supplierLeadTime";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { assertBranchAccess } from "@/lib/auth/guards";
import { recordAudit } from "@/lib/audit/log";

type Ctx = { params: Promise<{ id: string }> };

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
  qtyFifoApplied?: number;
};

export async function PUT(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    const body = await req.json();

    const purchase = await PurchaseOrder.findById(id);
    if (!purchase) {
      return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, purchase.branchId ? String(purchase.branchId) : null);
      if (denied) return denied;
    }

    // Received goods already sit in FIFO layers stamped with this PO's date,
    // cost and qty — those inputs are historical and locked once applied.
    const lockedError = NextResponse.json(
      {
        error:
          "Received lines are locked: their FIFO layers already exist at the received cost and date. Record a stock adjustment instead.",
      },
      { status: 400 },
    );
    const anyApplied = purchase.lines.some(
      (l: LineBody) => (Number(l.qtyFifoApplied) || 0) > 0,
    );
    if (body.date) {
      const nextDate = new Date(body.date);
      if (anyApplied && nextDate.getTime() !== new Date(purchase.date).getTime()) {
        return lockedError;
      }
      purchase.date = nextDate;
    }
    if (body.supplierId) purchase.supplierId = body.supplierId;
    if (body.supplierName) purchase.supplierName = body.supplierName;
    if (body.currency) purchase.currency = body.currency;
    if (body.notes !== undefined) purchase.notes = body.notes;

    // Full line replace. qtyFifoApplied is server-owned (never from the client:
    // resetting it would re-create layers for goods already received).
    if (Array.isArray(body.lines)) {
      const prevByProduct = new Map<string, { applied: number; unitCost: number }>(
        purchase.lines.map((l: LineBody): [string, { applied: number; unitCost: number }] => [
          String(l.productId),
          {
            applied: Number(l.qtyFifoApplied) || 0,
            unitCost: Number(l.unitCost ?? 0),
          },
        ]),
      );
      const nextLines = (body.lines as LineBody[])
        .map((l) => {
          const qtyOrdered = Number(l.qtyOrdered ?? l.qty ?? 0);
          const productId = String(l.productId);
          return {
            productId,
            productName: String(l.productName || "").trim() || "Product",
            sku: String(l.sku || ""),
            qtyOrdered,
            qtyReceived: Number(l.qtyReceived ?? 0),
            qtyFifoApplied: prevByProduct.get(productId)?.applied ?? 0,
            unitCost: Number(l.unitCost ?? 0),
          };
        })
        .filter((l) => l.productId && l.qtyOrdered > 0);
      // A line that already created FIFO layers keeps its product, unit cost
      // and at least the received qty those layers were created from.
      for (const [productId, prev] of prevByProduct) {
        if (prev.applied <= 0) continue;
        const next = nextLines.find((l) => l.productId === productId);
        if (!next || next.unitCost !== prev.unitCost || next.qtyReceived < prev.applied) {
          return lockedError;
        }
      }
      purchase.lines = nextLines;
      purchase.itemCount = purchase.lines.length;
      purchase.subtotal = purchase.lines.reduce(
        (s: number, l: LineBody) => s + Number(l.qtyOrdered) * Number(l.unitCost),
        0,
      );
    } else {
      if (body.subtotal !== undefined) purchase.subtotal = Number(body.subtotal);
      if (body.itemCount !== undefined) purchase.itemCount = Number(body.itemCount);
    }

    if (body.vatPercent !== undefined) {
      purchase.vatPercent = Math.max(0, Number(body.vatPercent));
    }

    // Recompute VAT + total whenever subtotal or vatPercent could have changed;
    // otherwise allow a direct total override (e.g. manual correction with no line/VAT edits).
    if (Array.isArray(body.lines) || body.vatPercent !== undefined || body.subtotal !== undefined) {
      purchase.vatAmount = Math.round(purchase.subtotal * (purchase.vatPercent / 100) * 100) / 100;
      purchase.total = Math.round((purchase.subtotal + purchase.vatAmount) * 100) / 100;
    } else if (body.total !== undefined) {
      purchase.total = Number(body.total);
    }

    // Convenience: receiveAll marks every line fully received
    if (body.receiveAll === true && purchase.lines.length) {
      for (const line of purchase.lines) {
        line.qtyReceived = line.qtyOrdered;
      }
      body.status = "received";
    }

    // Per-line receive deltas: { receive: [{ productId, qty }] } adds to qtyReceived
    if (Array.isArray(body.receive) && purchase.lines.length) {
      for (const r of body.receive as Array<{ productId: string; qty: number }>) {
        const line = purchase.lines.find(
          (l: LineBody) => String(l.productId) === String(r.productId),
        );
        if (!line) continue;
        line.qtyReceived = Math.min(
          line.qtyOrdered,
          (Number(line.qtyReceived) || 0) + Math.max(0, Number(r.qty) || 0),
        );
      }
    }

    let status = (body.status as string) || purchase.status;
    syncReceivedQtys(purchase.lines, status);
    if (purchase.lines.length) {
      status = derivePurchaseStatus(
        purchase.lines,
        status as "draft" | "ordered" | "received" | "partial",
      );
    }
    purchase.status = status as typeof purchase.status;

    // Apply FIFO for any newly received qty
    if (purchase.lines.length && (status === "received" || status === "partial")) {
      await applyFifoFromPurchase(purchase);
      purchase.markModified("lines");
    }

    // PUR-12: first time this PO lands fully received, stamp it and refresh supplier lead time.
    if (status === "received" && !purchase.receivedAt) {
      purchase.receivedAt = new Date();
    }

    await purchase.save();

    if (status === "received") {
      void recalcSupplierAvgLeadDays(String(purchase.supplierId));
    }

    recordAudit({
      session: access,
      action: "purchase_updated",
      entityType: "PurchaseOrder",
      entityId: id,
      detail: `status=${purchase.status}`,
      req,
    });
    return NextResponse.json(mapPO(toJSON(purchase)!));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update purchase") },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { id } = await ctx.params;
    const existing = await PurchaseOrder.findById(id);
    if (!existing) {
      return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
    }
    if (access) {
      const denied = assertBranchAccess(access, existing.branchId ? String(existing.branchId) : null);
      if (denied) return denied;
    }
    const purchase = await PurchaseOrder.findByIdAndDelete(id);
    if (!purchase) {
      return NextResponse.json({ error: "Purchase not found" }, { status: 404 });
    }
    // PUR-12: removing a received PO shifts the supplier's lead-time average.
    if (purchase.status === "received") {
      void recalcSupplierAvgLeadDays(String(purchase.supplierId));
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete purchase") },
      { status: 500 },
    );
  }
}
