import { canAccessReportCategory, resolveBranchScope } from "./access";
import { canAccessAllBranches } from "@/lib/auth/roles";
import { ReportAccessDeniedError, ReportNotFoundError } from "./errors";
import { previousPeriodFilters } from "./filters";
import { getReport } from "./registry";
import type { ReportContext, ReportFilters, ReportResult } from "./types";

export async function executeReport(
  id: string,
  ctx: ReportContext,
  rawFilters: ReportFilters,
): Promise<ReportResult> {
  const definition = getReport(id);
  if (!definition) throw new ReportNotFoundError(id);

  if (!canAccessReportCategory(ctx.session.role, definition.category)) {
    throw new ReportAccessDeniedError(id);
  }

  const branchId = definition.branchScoped
    ? resolveBranchScope(ctx.session, rawFilters.branchId)
    : rawFilters.branchId;
  // A branch-scoped role with no branch would otherwise resolve to "no filter"
  // — every branch. Non-owner accounts always get a branch (api/users), so this
  // is a broken account: refuse, like assertBranchAccess does.
  if (definition.branchScoped && branchId === null && !canAccessAllBranches(ctx.session.role)) {
    throw new ReportAccessDeniedError(id);
  }
  const filters: ReportFilters = { ...rawFilters, branchId };

  const { rows, totals } = await definition.run(ctx, filters);

  let compareTotals: Record<string, number> | null = null;
  if (filters.compare) {
    const prev = previousPeriodFilters(filters);
    compareTotals = (await definition.run(ctx, prev)).totals;
  }

  return {
    id: definition.id,
    label: definition.label,
    category: definition.category,
    generatedAt: new Date().toISOString(),
    range: { from: filters.from.toISOString(), to: filters.to.toISOString() },
    branchId: filters.branchId,
    columns: definition.columns,
    rows,
    totals,
    compareTotals,
  };
}
