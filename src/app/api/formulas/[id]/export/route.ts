import mongoose from "mongoose";
import { NextResponse } from "next/server";
import {
  isFormulaAdminResponse,
  requireFormulaAdmin,
} from "@/lib/auth/formulaAdmin";
import { connectDB } from "@/lib/db";
import { buildRecipeHtml } from "@/lib/formulas/recipeDocument";
import { mapFormula } from "@/lib/formulas/mapFormula";
import { Formula } from "@/lib/models";
import { toJSON } from "@/lib/serialize";
import type { Formula as FormulaType } from "@/lib/types";
import { isAuthResponse, requireApiAccess, safeErrorMessage } from "@/lib/auth/apiGuard";

type Ctx = { params: Promise<{ id: string }> };

/**
 * BLD-04: Admin-only print/export of a recipe.
 * ?disposition=inline → print preview
 * ?disposition=attachment → download (Save as PDF via browser / .html file)
 */
export async function GET(req: Request, ctx: Ctx) {
  try {
    const access = requireApiAccess(req);
    if (access !== null && isAuthResponse(access)) return access;

    const admin = requireFormulaAdmin(req);
    if (isFormulaAdminResponse(admin)) return admin;

    await connectDB();
    const { id } = await ctx.params;
    if (!mongoose.isValidObjectId(id)) {
      return NextResponse.json({ error: "Invalid formula id" }, { status: 400 });
    }
    const doc = await Formula.findById(id).lean();
    if (!doc) {
      return NextResponse.json({ error: "Formula not found" }, { status: 404 });
    }

    const formula = mapFormula(toJSON(doc)!) as FormulaType;
    const html = buildRecipeHtml(formula);
    const { searchParams } = new URL(req.url);
    const disposition =
      searchParams.get("disposition") === "attachment"
        ? "attachment"
        : "inline";
    const safeName = (formula.name || "formula")
      .replace(/[^\w\-]+/g, "_")
      .slice(0, 60);

    return new NextResponse(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Disposition": `${disposition}; filename="${safeName}.html"`,
        "Cache-Control": "no-store",
        "X-Formula-Exported-By": admin.name,
      },
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          safeErrorMessage(error, "Failed to export formula"),
      },
      { status: 500 },
    );
  }
}
