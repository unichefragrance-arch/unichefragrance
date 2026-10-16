import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { Expense } from "@/lib/models";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { recordAudit } from "@/lib/audit/log";
import { branchScopeFilter } from "@/lib/auth/guards";

export function mapExpense(e: Record<string, unknown>) {
  return {
    ...e,
    date: e.date ? new Date(e.date as string).toISOString().slice(0, 10) : null,
  };
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    // Same isolation as sales / purchases: a non-owner with no branch sees
    // only unbranched (legacy) expenses, never every branch.
    const filter = (access && branchScopeFilter(access)) || {};
    const expenses = await Expense.find(filter).sort({ date: -1 });
    return NextResponse.json(toJSONList(expenses).map(mapExpense));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load expenses") },
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
    // Ids and timestamps are set by the server, never by the request.
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { _id, id, __v, createdAt, updatedAt, ...fields } = body ?? {};
    const expense = await Expense.create({
      ...fields,
      date: new Date(body.date || Date.now()),
      status: body.status || "pending",
      branchId: access?.branchId ?? undefined,
      branchName: access?.branchName ?? undefined,
    });
    recordAudit({
      session: access,
      action: "expense_created",
      entityType: "Expense",
      entityId: String(expense._id),
      detail: `${expense.category || ""} · ${expense.amount}`,
      req,
    });
    return NextResponse.json(mapExpense(toJSON(expense)!), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create expense") },
      { status: 400 },
    );
  }
}
