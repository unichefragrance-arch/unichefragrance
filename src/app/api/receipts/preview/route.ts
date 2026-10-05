import { NextResponse } from "next/server";
import { buildReceiptDoc } from "@/lib/receipt/document";
import { loadReceiptSettings, parseFormat } from "@/lib/receipt/server";
import { renderReceiptHtml } from "@/lib/receipt/template";
import type { ReceiptLine } from "@/lib/receipt/types";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

type Body = {
  format?: string;
  customerName?: string;
  customerPhone?: string;
  salesperson?: string;
  payment?: string;
  total?: number;
  discountTotal?: number;
  lines?: ReceiptLine[];
};

/** Renders the live cart as a draft bill — used by the POS print button before checkout. */
export async function POST(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const body = (await req.json()) as Body;
    const lines = (body.lines ?? []).map((line) => ({
      name: String(line.name ?? ""),
      qty: Number(line.qty ?? 0),
      unitLabel: String(line.unitLabel ?? ""),
      unitPrice: Number(line.unitPrice ?? 0),
      note: line.note ? String(line.note) : undefined,
    }));

    if (lines.length === 0) {
      return NextResponse.json(
        { error: "Add items before printing a draft bill" },
        { status: 400 },
      );
    }

    const settings = await loadReceiptSettings();
    const doc = buildReceiptDoc({
      draft: true,
      customer: {
        name: body.customerName || "",
        phone: body.customerPhone || "",
      },
      salesperson: body.salesperson,
      payment: body.payment,
      lines,
      total: body.total,
      discountTotal: body.discountTotal,
      settings,
    });

    return new Response(renderReceiptHtml(doc, parseFormat(body.format)), {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to render draft bill"),
      },
      { status: 400 },
    );
  }
}
