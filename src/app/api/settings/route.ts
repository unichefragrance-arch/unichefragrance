import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { AppSettings } from "@/lib/models";
import { smsConfigured } from "@/lib/notifications/sms";
import { invalidateReceiptSettingsCache } from "@/lib/receipt/server";
import { toJSON } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

export function normalizeSalespeople(value: unknown, fallbackName?: string) {
  const list = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/\n|,/)
      : [];
  const names = Array.from(
    new Set(
      list
        .map((name) => String(name ?? "").trim())
        .filter(Boolean),
    ),
  );
  if (names.length > 0) return names;
  const fallback = String(fallbackName || "Ahmad Ibrahim").trim();
  return fallback ? [fallback] : ["Ahmad Ibrahim"];
}

export function normalizeActiveSalesperson(
  value: unknown,
  salespeople: string[],
  fallbackName?: string,
) {
  const requested = String(value ?? "").trim();
  const matched = salespeople.find(
    (name) => name.toLowerCase() === requested.toLowerCase(),
  );
  if (matched) return matched;
  return salespeople[0] || String(fallbackName || "Ahmad Ibrahim").trim();
}

function withSalesTeamDefaults(json: Record<string, unknown>) {
  const salespeople = normalizeSalespeople(
    json.salespeople,
    String(json.currentUserName || ""),
  );
  const activeSalesperson = normalizeActiveSalesperson(
    json.activeSalesperson,
    salespeople,
    String(json.currentUserName || ""),
  );
  return {
    ...json,
    salespeople,
    activeSalesperson,
    // Env-derived, never persisted — lets the POS enable/disable the SMS action.
    smsConfigured: smsConfigured(),
  };
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    let settings = await AppSettings.findOne({ key: "default" });
    if (!settings) {
      settings = await AppSettings.create({ key: "default" });
    }
    return NextResponse.json(withSalesTeamDefaults(toJSON(settings)!));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load settings") },
      { status: 500 },
    );
  }
}

export async function PUT(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return NextResponse.json({ error: "Request body must be a JSON object" }, { status: 400 });
    }

    const rest = { ...body };
    delete rest.id;
    delete rest._id;
    delete rest.__v;
    delete rest.key;
    delete rest.smsConfigured;
    delete rest.salespeople;
    delete rest.activeSalesperson;

    // Partial update: the sales team is only rewritten when the request
    // carries it, so saving one field (e.g. POS auto-print) can't reset it.
    if (body.salespeople !== undefined || body.activeSalesperson !== undefined) {
      const fallbackName =
        typeof body.currentUserName === "string" ? body.currentUserName : undefined;
      const current =
        body.salespeople === undefined
          ? await AppSettings.findOne({ key: "default" }).select("salespeople").lean<{ salespeople?: unknown }>()
          : null;
      const salespeople = normalizeSalespeople(body.salespeople ?? current?.salespeople, fallbackName);
      rest.salespeople = salespeople;
      rest.activeSalesperson = normalizeActiveSalesperson(body.activeSalesperson, salespeople, fallbackName);
    }

    const settings = await AppSettings.findOneAndUpdate(
      { key: "default" },
      { $set: rest },
      { returnDocument: "after", upsert: true, runValidators: true },
    );
    invalidateReceiptSettingsCache();
    return NextResponse.json(withSalesTeamDefaults(toJSON(settings)!));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update settings") },
      { status: 400 },
    );
  }
}
