import mongoose from "mongoose";
import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { DeliveryLog, Sale } from "@/lib/models";
import { logDelivery } from "@/lib/notifications/log";
import { receiptNumberFor } from "@/lib/receipt/document";
import { toJSONList } from "@/lib/serialize";
import type { DeliveryChannel, DeliveryStatus } from "@/lib/types";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { assertBranchAccess } from "@/lib/auth/guards";
import { canAccessAllBranches } from "@/lib/auth/roles";

const CHANNELS: DeliveryChannel[] = ["print", "email", "whatsapp", "sms"];
const STATUSES: DeliveryStatus[] = ["sent", "failed", "handoff", "printed"];

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const saleId = searchParams.get("saleId");
    const channel = searchParams.get("channel");
    const limit = Math.min(Number(searchParams.get("limit") || 50), 200);

    // Delivery entries hold customer phones / emails: outside Owner, only a
    // sale's own branch may read them, one sale at a time.
    if (access && !canAccessAllBranches(access.role)) {
      if (!saleId || !mongoose.isValidObjectId(saleId)) {
        return NextResponse.json({ error: "saleId is required" }, { status: 400 });
      }
      const sale = await Sale.findById(saleId).select("branchId").lean<{ branchId?: unknown }>();
      if (!sale) {
        return NextResponse.json({ error: "Sale not found" }, { status: 404 });
      }
      const denied = assertBranchAccess(access, sale.branchId ? String(sale.branchId) : null);
      if (denied) return denied;
    }

    const filter: Record<string, unknown> = {};
    if (saleId) filter.saleId = saleId;
    if (channel && CHANNELS.includes(channel as DeliveryChannel)) {
      filter.channel = channel;
    }

    const entries = await DeliveryLog.find(filter)
      .sort({ createdAt: -1 })
      .limit(limit);
    return NextResponse.json(toJSONList(entries));
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to load delivery log"),
      },
      { status: 500 },
    );
  }
}

/** Records browser-side deliveries (print jobs, opened WhatsApp hand-offs). */
export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const body = (await req.json()) as Record<string, unknown>;
    const channel = String(body.channel || "") as DeliveryChannel;
    const status = String(body.status || "sent") as DeliveryStatus;

    if (!CHANNELS.includes(channel)) {
      return NextResponse.json({ error: "Unknown channel" }, { status: 400 });
    }
    if (!STATUSES.includes(status)) {
      return NextResponse.json({ error: "Unknown status" }, { status: 400 });
    }

    const saleId = body.saleId ? String(body.saleId) : undefined;
    const receiptNo = body.receiptNo
      ? String(body.receiptNo)
      : await receiptNumberForSale(saleId);

    await logDelivery({
      channel,
      status,
      kind: body.kind === "quotation" ? "quotation" : "receipt",
      saleId,
      receiptNo,
      format: body.format ? String(body.format) : undefined,
      to: body.to ? String(body.to) : undefined,
      error: body.error ? String(body.error) : undefined,
    });

    return NextResponse.json({ ok: true });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to record delivery"),
      },
      { status: 400 },
    );
  }
}

async function receiptNumberForSale(saleId?: string): Promise<string> {
  if (!saleId) return "";
  await connectDB();
  const sale = await Sale.findById(saleId).select("createdAt").lean<{
    createdAt?: Date;
  }>();
  if (!sale) return "";
  return receiptNumberFor(saleId, new Date(sale.createdAt ?? Date.now()));
}
