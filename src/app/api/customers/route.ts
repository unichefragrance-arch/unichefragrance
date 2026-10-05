import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { customerProfileFields } from "@/lib/customers/profileFields";
import { Customer } from "@/lib/models";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { escapeRegex, loosePhoneRegex, phoneDigits } from "@/lib/phone";

function mapCustomer(c: Record<string, unknown>) {
  return {
    ...c,
    lastVisit: c.lastVisit
      ? new Date(c.lastVisit as string).toISOString().slice(0, 10)
      : null,
  };
}

export async function GET(req: Request) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    await connectDB();
    const { searchParams } = new URL(req.url);
    const q = searchParams.get("q")?.trim();
    const filter: Record<string, unknown> = {};
    if (q) {
      const safe = escapeRegex(q);
      const digits = phoneDigits(q);
      const or: Record<string, unknown>[] = [
        { name: { $regex: safe, $options: "i" } },
        { phone: { $regex: safe, $options: "i" } },
      ];
      // Match phones saved with/without +, spaces, or country code extras.
      if (digits.length >= 7) {
        or.push({ phone: { $regex: loosePhoneRegex(digits) } });
      }
      filter.$or = or;
    }
    const customers = await Customer.find(filter).sort({ name: 1 });
    return NextResponse.json(toJSONList(customers).map(mapCustomer));
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to load customers") },
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

    // CRM-11: block accidental duplicates on phone/email unless the caller
    // already confirmed "Create New" after seeing the match.
    if (!body.forceCreate) {
      const digits = phoneDigits(String(body.phone || ""));
      const email = String(body.email || "").trim().toLowerCase();
      const or: Record<string, unknown>[] = [];
      if (digits.length >= 7) {
        or.push({ phone: { $regex: loosePhoneRegex(digits) } });
      }
      if (email) {
        or.push({ email: { $regex: `^${escapeRegex(email)}$`, $options: "i" } });
      }
      if (or.length > 0) {
        const existing = await Customer.findOne({ $or: or });
        if (existing) {
          return NextResponse.json(
            {
              error: "duplicate",
              message: "A customer with this phone or email already exists.",
              existing: mapCustomer(toJSON(existing)!),
            },
            { status: 409 },
          );
        }
      }
    }

    // New customers start with zero balance / purchases — never client-set.
    const customer = await Customer.create({
      ...customerProfileFields(body),
      lastVisit: new Date(),
    });
    return NextResponse.json(mapCustomer(toJSON(customer)!), { status: 201 });
  } catch (error) {
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create customer") },
      { status: 400 },
    );
  }
}
