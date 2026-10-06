import dns from "node:dns";
import "dotenv/config";

dns.setDefaultResultOrder("ipv4first");
try {
  dns.setServers(["8.8.8.8", "1.1.1.1"]);
} catch {
  // ignore
}

import mongoose from "mongoose";
import { connectDB } from "../src/lib/db";
import {
  AppSettings,
  Branch,
  Customer,
  Expense,
  Product,
  PurchaseOrder,
  Sale,
  Supplier,
} from "../src/lib/models";
import { assertLocalOnlyTarget } from "./lib/dbSafety";

/**
 * Additive seed for the Accountant's Report Center (sales, purchase, profit,
 * finance, customer categories — see ROLE_REPORT_CATEGORIES in
 * src/lib/reporting-engine/access.ts). Run AFTER `npm run db:seed`, which
 * clears the DB; this script only inserts on top of it.
 *
 * Every doc below is stamped with the seeded main branch's branchId because
 * report queries pin non-owner roles (incl. accountant) to their session
 * branch (resolveBranchScope in reporting-engine/access.ts) — data without
 * a branchId is invisible to that role, which is why dates are spread across
 * this calendar month and last (ending today) rather than reusing the base
 * seed's fixed July dates.
 */

function daysAgo(n: number, hour = 12, minute = 0) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  d.setHours(hour, minute, 0, 0);
  return d;
}

async function main() {
  // Destructive: local databases only — refuses Atlas/remote/unset targets, no override.
  assertLocalOnlyTarget("seed-accountant-reports");
  console.log("Connecting to MongoDB...");
  await connectDB();

  const branch = await Branch.findOne({ code: "MAIN" }).lean();
  if (!branch) {
    throw new Error("No branch found — run `npm run db:seed` first.");
  }

  const products = await Product.find({}).lean();
  if (products.length === 0) {
    throw new Error("No products found — run `npm run db:seed` first.");
  }
  const bySku = Object.fromEntries(products.map((p) => [p.sku, p]));

  const suppliers = await Supplier.find({}).lean();
  if (suppliers.length === 0) {
    throw new Error("No suppliers found — run `npm run db:seed` first.");
  }

  const customers = await Customer.find({}).lean();
  const custByPhone = new Map(customers.map((c) => [c.phone, c._id]));

  // ---- Salespeople: base seed only has one, add two more for a real spread ----
  const salespeople = ["Ahmad Ibrahim", "Sara Ahmed", "Youssef Nasser"];
  await AppSettings.updateOne(
    { key: "default" },
    { $addToSet: { salespeople: { $each: salespeople } } },
  );

  // ---- Sales: this month + last month (full calendar coverage — matters
  //      because the dashboard's Net Profit Margin trend badge compares
  //      this month's margin to last month's; if sales only covered a
  //      trailing 30 days while expenses covered full calendar months,
  //      last month looked artificially starved of revenue), mixed
  //      salesperson/payment/product, with FIFO cost on each line so
  //      Profit & margin daily has real numbers to show ----
  const saleSkus = ["BP-001", "SG-001", "PO-012", "SN-004", "RM-STD", "BM-003", "BK-002", "PO-001", "GB-001"];
  const payments = ["cash", "card", "bank", "credit", "mixed"];
  const customerPool = [
    { phone: "+971 50 123 4567", name: "Fatima Al Mazrouei" },
    { phone: "+971 55 987 1122", name: "Omar Hassan" },
    { phone: "+971 4 330 8899", name: "Noor Trading LLC" },
    { phone: "+971 52 441 7788", name: "Sara Khalid" },
    { phone: "+971 58 220 3344", name: "Walk-in" },
  ];

  const now = new Date();
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const todayMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const totalSaleDays =
    Math.floor((todayMidnight.getTime() - startOfLastMonth.getTime()) / 86400000) + 1;

  const saleDocs: Record<string, unknown>[] = [];
  let n = 0;
  for (let dOffset = 0; dOffset < totalSaleDays; dOffset++) {
    const day = new Date(startOfLastMonth);
    day.setDate(day.getDate() + dOffset);
    const salesToday = 2 + (dOffset % 3); // 2-4 sales/day
    for (let i = 0; i < salesToday; i++) {
      const sku = saleSkus[n % saleSkus.length];
      const product = bySku[sku];
      if (!product) {
        n++;
        continue;
      }
      const createdAt = new Date(
        day.getFullYear(),
        day.getMonth(),
        day.getDate(),
        9 + (n % 10),
        (n * 7) % 60,
        0,
        0,
      );
      if (createdAt > now) {
        n++;
        continue; // hasn't happened yet today
      }
      const qty = 1 + (n % 4);
      const unitPrice = product.sellPrice > 0 ? product.sellPrice : 50;
      const total = Math.round(unitPrice * qty * 100) / 100;
      const cost = Math.round((product.costFifo || 0) * qty * 100) / 100;
      const salesperson = salespeople[n % salespeople.length];
      const payment = payments[n % payments.length];
      const customer = customerPool[n % customerPool.length];

      saleDocs.push({
        createdAt,
        customerPhone: customer.phone,
        customerName: customer.name,
        customerId: custByPhone.get(customer.phone),
        salesperson,
        payment,
        status: "completed",
        saleType: "Retail",
        subtotal: total,
        total,
        lines: [
          {
            productId: product._id,
            name: product.name,
            qty,
            unitLabel: product.unit,
            unitPrice,
            lineType: "ready",
          },
        ],
        inventoryDeductions: [
          {
            productId: product._id,
            productName: product.name,
            qty,
            reason: "sale",
            lineIndex: 0,
            costTotal: cost,
          },
        ],
        branchId: branch._id,
        branchName: branch.name,
      });
      n++;
    }
  }
  await Sale.insertMany(saleDocs);

  // ---- Expenses: this month + last month, fixed costs posted once each ----
  // (Rent/Salaries repeating every ~2 days was the bug that drove the
  // dashboard's Net Profit Margin to -127% — big fixed costs stacked up
  // 4-6x in a single month and swamped revenue. They post once per
  // calendar month now, like a real business.)
  const monthlyExpensePlan: {
    dayOfMonth: number;
    category: string;
    detail: string;
    amount: number;
    status?: string;
  }[] = [
    { dayOfMonth: 2, category: "Rent", detail: "Shop rent — monthly", amount: 7000 },
    { dayOfMonth: 6, category: "Utilities", detail: "DEWA bill", amount: 610 },
    { dayOfMonth: 9, category: "Marketing", detail: "Instagram ads", amount: 320 },
    { dayOfMonth: 12, category: "Packaging", detail: "Boxes & labels restock", amount: 260 },
    { dayOfMonth: 14, category: "Petty Cash", detail: "Office supplies", amount: 95 },
    { dayOfMonth: 18, category: "Maintenance", detail: "AC servicing", amount: 420 },
    { dayOfMonth: 21, category: "Transport", detail: "Courier & delivery", amount: 210 },
    { dayOfMonth: 24, category: "Petty Cash", detail: "Cleaning supplies", amount: 80 },
    { dayOfMonth: 26, category: "Marketing", detail: "Flyer printing", amount: 150, status: "rejected" },
    { dayOfMonth: 28, category: "Salaries", detail: "Staff salaries", amount: 3500 },
  ];

  const expenseDocs: Record<string, unknown>[] = [];
  for (let monthOffset = 0; monthOffset <= 1; monthOffset++) {
    for (const item of monthlyExpensePlan) {
      const date = new Date(
        now.getFullYear(),
        now.getMonth() - monthOffset,
        item.dayOfMonth,
        10,
        0,
        0,
        0,
      );
      if (date > now) continue; // hasn't happened yet this month
      const daysOld = Math.floor((now.getTime() - date.getTime()) / 86400000);
      expenseDocs.push({
        date,
        category: item.category,
        detail: item.detail,
        amount: item.amount,
        status: item.status ?? (daysOld <= 3 ? "pending" : "approved"),
        branchId: branch._id,
        branchName: branch.name,
      });
    }
  }
  await Expense.insertMany(expenseDocs);

  // ---- Purchase orders: 30 days, all 4 suppliers, mixed status ----
  const purchaseSkus = [
    "ETH-96", "BOT-100", "CAP-STD", "ATM-STD",
    "COL-STD", "LBL-STD", "BOX-STD", "PCH-STD", "FIX-STD",
  ];
  const poStatuses = ["received", "received", "partial", "ordered"];

  const poDocs: Record<string, unknown>[] = [];
  for (let i = 0; i < 16; i++) {
    const supplier = suppliers[i % suppliers.length];
    const dayOffset = Math.max(0, 28 - i * 2);
    const status = poStatuses[i % poStatuses.length];
    const lineSkus = [purchaseSkus[i % purchaseSkus.length], purchaseSkus[(i + 3) % purchaseSkus.length]];

    const lines = lineSkus.map((sku, idx) => {
      const p = bySku[sku];
      const qtyOrdered = 100 * (idx + 1) + i * 10;
      const qtyReceived =
        status === "ordered" ? 0 : status === "partial" ? Math.floor(qtyOrdered * 0.5) : qtyOrdered;
      return {
        productId: p._id,
        productName: p.name,
        sku,
        qtyOrdered,
        qtyReceived,
        qtyFifoApplied: 0,
        unitCost: p.costFifo || 1,
      };
    });
    const total = Math.round(lines.reduce((s, l) => s + l.qtyOrdered * l.unitCost, 0) * 100) / 100;

    poDocs.push({
      supplierId: supplier._id,
      supplierName: supplier.name,
      date: daysAgo(dayOffset, 11, 0),
      status,
      currency: supplier.currency,
      total,
      itemCount: lines.length,
      lines,
      branchId: branch._id,
      branchName: branch.name,
    });
  }
  await PurchaseOrder.insertMany(poDocs);

  console.log("Accountant report seed complete:");
  console.log(`  Sales added: ${saleDocs.length}`);
  console.log(`  Expenses added: ${expenseDocs.length}`);
  console.log(`  Purchase orders added: ${poDocs.length}`);
  console.log(`  Salespeople now: ${salespeople.join(", ")}`);
  console.log("Log in as accounts@unich.local (see .env / ACCOUNTANT_PASSWORD) and open Report Center.");
  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Seed failed:", err);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
