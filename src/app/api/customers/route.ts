import { NextResponse } from "next/server";
import { connectDB } from "@/lib/db";
import { customerProfileFields } from "@/lib/customers/profileFields";
import { Customer } from "@/lib/models";
import { toJSON, toJSONList } from "@/lib/serialize";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";
import { escapeRegex, loosePhoneRegex, phoneDigits } from "@/lib/phone";

/** Most customers a search (`?q=`) returns. */
const SEARCH_LIMIT = 50;

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
    if (!q) {
      // Full list for the Customers page (lean: no document hydration).
      const customers = await Customer.find().sort({ name: 1 }).lean();
      return NextResponse.json(toJSONList(customers).map(mapCustomer));
    }

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
    // A search is a lookup, not an export: a short query ("Al") used to
    // return thousands of customers and stall the server for every till.
    // Phones ending in the typed digits come first so the POS exact /
    // suffix match is never cut off by the cap.
    const phoneHits =
      digits.length >= 7
        ? await Customer.find({ phone: { $regex: `${loosePhoneRegex(digits)}\\D*$` } })
            .sort({ name: 1 })
            .limit(SEARCH_LIMIT)
            .lean()
        : [];
    const seen = new Set(phoneHits.map((c) => String(c._id)));
    const room = SEARCH_LIMIT - phoneHits.length;
    // (limit(0) means "no limit" in MongoDB — never send it.)
    const others =
      room > 0
        ? await Customer.find({ $or: or, _id: { $nin: [...seen] } })
            .sort({ name: 1 })
            .limit(room)
            .lean()
        : [];
    return NextResponse.json(toJSONList([...phoneHits, ...others]).map(mapCustomer));
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
