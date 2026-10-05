export type UserRole =
  | "owner"
  | "manager"
  | "cashier"
  | "accountant"
  | "inventory"
  | "branch_manager";

/** BRN-08 branch (multi-store). */
export type Branch = {
  id: string;
  name: string;
  code: string;
  active: boolean;
  createdAt?: string;
  updatedAt?: string;
};

/** BRN-08 system user (role + branch assignment). */
export type AppUser = {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  roleLabel: string;
  branchId: string | null;
  branchName: string | null;
  active: boolean;
  lastLoginAt?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

/** Public session payload (never includes password). */
export type AuthMe = {
  authenticated: boolean;
  user: AppUser | null;
  permissions: string[];
};

export type ProductCategory =
  | "Brands"
  | "Remix"
  | "Body Mist"
  | "Body Spray"
  | "Coffret"
  | "Bakhoor"
  | "Single Notes"
  | "Signature Brand"
  | "Niche Brand"
  | "Packaging";

export type StockUnit = "pcs" | "ml" | "g" | "kg";
export type StockBucket = "sellable" | "tester" | "sample" | "personal";
export type ItemType = "finished" | "packaging" | "raw";
export type Concentration =
  | "EDT"
  | "EDP"
  | "Extrait"
  | "Parfum"
  | "Oil"
  | "Mist"
  | "Other";

export type ImportRowAction = "create" | "update" | "error";
export type ImportBatchStatus = "staged" | "committed" | "undone";

export type PaymentMethod = "cash" | "card" | "bank" | "credit" | "mixed";

/** One slice of a "mixed" payment — e.g. part cash, part credit. */
export type PaymentSplit = {
  method: Exclude<PaymentMethod, "mixed">;
  amount: number;
};

export type QuotationStatus =
  | "draft"
  | "sent"
  | "revised"
  | "approved"
  | "rejected"
  | "expired"
  | "converted";

export interface Product {
  id: string;
  sku: string;
  name: string;
  nameAr?: string;
  category: ProductCategory;
  unit: StockUnit;
  sellPrice: number;
  wholesalePrice?: number;
  minMarginPct: number;
  costFifo: number;
  brand?: string;
  concentration?: string;
  gender?: string;
  size?: string;
  collection?: string;
  notes?: string;
  itemType?: ItemType;
  importBatchId?: string | null;
  stockSellable: number;
  stockTester: number;
  stockSample: number;
  stockPersonal: number;
  lowStockAt: number;
  isQuickButton?: boolean;
  tags?: string[];
}

export interface ImportBatchRow {
  rowNumber: number;
  action: ImportRowAction;
  sku: string;
  payload?: Record<string, unknown>;
  errorReason?: string;
  priceFloorViolation?: boolean;
}

export interface ImportBatchSummary {
  batchId: string;
  fileName: string;
  status: ImportBatchStatus;
  total: number;
  created: number;
  updated: number;
  failed: number;
  priceFloorCount: number;
  rows: ImportBatchRow[];
}

export interface FifoLayer {
  id: string;
  productId: string;
  supplierId: string;
  supplierName: string;
  purchaseDate: string;
  qtyRemaining: number;
  unitCost: number;
  currency: string;
  source?: "purchase" | "production";
  productionOrderId?: string;
}

export interface Customer {
  id: string;
  name: string;
  phone: string;
  email?: string;
  address?: string;
  vatNumber?: string;
  productsRequested: string[];
  notes?: string;
  preferences: string[];
  totalPurchases: number;
  lastVisit: string;
  creditBalance: number;
  hasCustomFormula: boolean;
}

export interface Supplier {
  id: string;
  name: string;
  phone: string;
  currency: string;
  creditLimit: number;
  outstanding: number;
  lastPurchase: string;
  avgLeadDays: number;
}

export interface FormulaComponent {
  productId: string;
  productName: string;
  qty: number;
  unit: StockUnit;
}

export type FormulaStatus = "draft" | "approved" | "rejected" | "archived";

export type FormulaAuditAction =
  | "created"
  | "updated"
  | "status_changed"
  | "restored";

/** Append-only change log (separate from recipe version snapshots). */
export interface FormulaAuditEntry {
  at: string;
  by?: string;
  action: FormulaAuditAction;
  detail?: string;
  fromStatus?: FormulaStatus;
  toStatus?: FormulaStatus;
  fromVersion?: number;
  toVersion?: number;
}

/** BLD-02 fixed BOM/formula types — not PRD-01 product categories. */
export type FormulaType = "remix" | "oil" | "bakhoor";

/** Snapshot of a formula recipe before an edit (immutable history). */
export interface FormulaVersion {
  version: number;
  name: string;
  type: FormulaType;
  status: FormulaStatus;
  customerId?: string;
  customerName?: string;
  yieldMl: number;
  components: FormulaComponent[];
  notes?: string;
  savedAt: string;
  savedBy?: string;
}

/** POS/customer-safe hint when recipe components are redacted (BLD-04). */
export interface FormulaReuseHints {
  needsOilSelection: boolean;
  oilProductId?: string;
  oilProductName?: string;
}

/** BLD-12: raw-material reservation tied to approval status. */
export interface MaterialsReservation {
  active: boolean;
  reservedAt?: string;
  lines: Array<{
    productId: string;
    productName: string;
    qty: number;
    unit: StockUnit | string;
  }>;
}

export interface Formula {
  id: string;
  name: string;
  type: FormulaType;
  status: FormulaStatus;
  /** Current recipe revision (starts at 1). */
  version: number;
  /** Prior revisions; newest push last. */
  versions: FormulaVersion[];
  /** Audit / change log. */
  history: FormulaAuditEntry[];
  customerId?: string;
  customerName?: string;
  yieldMl: number;
  components: FormulaComponent[];
  notes?: string;
  approvedAt?: string;
  approvedBy?: string;
  /** BLD-12: active only when status === approved. */
  materialsReservation?: MaterialsReservation;
  updatedAt: string;
  /** True when API stripped recipe secrecy fields for non-admin. */
  recipeHidden?: boolean;
  reuseHints?: FormulaReuseHints;
}

export interface PurchaseOrderLine {
  id: string;
  productId: string;
  productName: string;
  sku: string;
  qtyOrdered: number;
  qtyReceived: number;
  qtyFifoApplied: number;
  unitCost: number;
}

export interface PurchaseOrder {
  id: string;
  supplierId: string;
  supplierName: string;
  date: string;
  status: "draft" | "ordered" | "received" | "partial";
  currency: string;
  subtotal: number;
  vatPercent: number;
  vatAmount: number;
  total: number;
  itemCount: number;
  lines: PurchaseOrderLine[];
  notes?: string;
}

export type ProductionOrderStatus = "draft" | "completed" | "cancelled";

export interface ProductionPlannedLine {
  productId: string;
  productName: string;
  qty: number;
  unit: StockUnit | string;
  reason: string;
  /** INV-06 preview fields (production plan only). */
  stockAvailable?: number;
  fifoAvailable?: number;
  stockShort?: boolean;
  stockWarning?: string;
}

export interface ProductionConsumptionLine {
  productId: string;
  productName: string;
  qty: number;
  reason: string;
  costTotal: number;
  batches: Array<{
    layerId: string;
    qty: number;
    unitCost: number;
    purchaseDate: string;
  }>;
}

export interface ProductionBatch {
  batchNumber: string;
  producedAt: string;
  outputProductId: string;
  outputProductName: string;
  outputSku: string;
  outputQty: number;
  outputUnit: StockUnit | string;
  unitCost: number;
  totalMaterialCost: number;
  fifoLayerId?: string;
}

export interface ProductionOrder {
  id: string;
  orderNumber: string;
  formulaId: string;
  formulaName: string;
  formulaType: FormulaType;
  formulaVersion: number;
  qty: number;
  /** BLD-06 expected yield (formula.yieldMl × qty). */
  yieldMl: number;
  /** BLD-06 actual measured yield on complete. */
  actualYieldMl?: number;
  /** BLD-06: actual − expected. */
  varianceMl?: number;
  /** BLD-06: shortfall when actual < expected. */
  wastageMl?: number;
  /** BLD-06: |variance| ≤ ±5 ml. */
  withinTolerance?: boolean;
  status: ProductionOrderStatus;
  oilProductId?: string;
  oilProductName?: string;
  outputProductId: string;
  outputProductName: string;
  outputSku: string;
  outputUnit: StockUnit | string;
  outputQty: number;
  plannedLines: ProductionPlannedLine[];
  consumption: ProductionConsumptionLine[];
  batch?: ProductionBatch | null;
  notes?: string;
  createdBy?: string;
  completedAt?: string;
  completedBy?: string;
  cancelledAt?: string;
  createdAt?: string;
  updatedAt?: string;
}

/** INV-07 wastage liability on inventory adjustments. */
export type WastageLiability = "cost" | "customer_paid";

export type InventoryAdjustmentReason =
  | "wastage_cost"
  | "wastage_customer"
  | "restock"
  | "adjustment";

export type QuotationLineType =
  | "ready"
  | "remix"
  | "oil"
  | "refill"
  | "packaging"
  | "wholesale"
  | "custom_blend";

export interface QuotationLine {
  productId?: string;
  name: string;
  qty: number;
  unitLabel: string;
  unitPrice: number;
  lineType: QuotationLineType;
  /** QTN-09 custom-blend refs — recipe stays secret, only the link is stored. */
  formulaId?: string;
  formulaName?: string;
  packagingProductIds?: string[];
  bottleNote?: string;
  designNote?: string;
  charges?: number;
  notes?: string;
}

export interface QuotationAttachment {
  name: string;
  mimeType: string;
  dataBase64: string;
  uploadedAt: string;
}

/** QTN-05 immutable snapshot captured before a revision is applied. */
export interface QuotationVersion {
  version: number;
  status: QuotationStatus;
  lines: QuotationLine[];
  subtotal: number;
  vatPercent: number;
  vatAmount: number;
  total: number;
  paymentTerms?: string;
  deliveryTerms?: string;
  validityDays?: number;
  termsText?: string;
  notes?: string;
  savedAt: string;
  savedBy?: string;
}

export type QuotationAuditAction =
  | "created"
  | "updated"
  | "status_changed"
  | "revised"
  | "shared"
  | "converted"
  | "customer_decision";

export interface QuotationHistoryEntry {
  at: string;
  by?: string;
  action: QuotationAuditAction;
  detail?: string;
  fromStatus?: QuotationStatus;
  toStatus?: QuotationStatus;
  fromVersion?: number;
  toVersion?: number;
}

export interface Quotation {
  id: string;
  number: string;
  customerId?: string;
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerTrn?: string;
  customerAddress?: string;
  status: QuotationStatus;
  date: string;
  expiry: string;

  lines: QuotationLine[];
  subtotal: number;
  vatPercent: number;
  vatAmount: number;
  total: number;

  /** QTN-07 */
  customerPoNumber?: string;
  attachments: QuotationAttachment[];

  /** QTN-03 */
  paymentTerms?: string;
  deliveryTerms?: string;
  validityDays: number;
  termsText?: string;
  notes?: string;

  /** QTN-02 */
  signatureDataUrl?: string;
  signedByName?: string;
  signedAt?: string;

  /** QTN-05 */
  version: number;
  versions: QuotationVersion[];
  history: QuotationHistoryEntry[];

  /** QTN-10 public approval link */
  approvalToken?: string;
  approvalTokenExpiresAt?: string;
  publicViewedAt?: string;
  customerDecision?: "approved" | "rejected";
  customerDecisionAt?: string;
  customerDecisionNote?: string;

  convertedToSaleId?: string;
}

/** Redacted customer-facing view served by the public approval link (QTN-10). */
export interface PublicQuotation {
  number: string;
  status: QuotationStatus;
  date: string;
  expiry: string;
  store: { name: string; legalName: string; address: string; phone: string; taxNumber: string; logoUrl: string; currency: string };
  customerName: string;
  customerPhone: string;
  customerEmail?: string;
  customerTrn?: string;
  customerAddress?: string;
  customerPoNumber?: string;
  lines: QuotationLine[];
  subtotal: number;
  vatPercent: number;
  vatAmount: number;
  total: number;
  paymentTerms?: string;
  deliveryTerms?: string;
  validityDays: number;
  termsText?: string;
  notes?: string;
  signatureDataUrl?: string;
  signedByName?: string;
  signedAt?: string;
  customerDecision?: "approved" | "rejected";
  customerDecisionAt?: string;
  customerDecisionNote?: string;
  expired: boolean;
}

export interface SaleLine {
  id: string;
  productId: string;
  name: string;
  qty: number;
  unit: StockUnit | "tola" | "half_tola" | "quarter_tola";
  unitPrice: number;
  lineType: "ready" | "remix" | "oil" | "refill" | "packaging";
}

export interface DashboardAlert {
  id: string;
  type: "low_stock" | "dead_stock" | "transfer" | "report" | "receivables" | "payables";
  title: string;
  detail: string;
  severity: "info" | "warning" | "critical";
}

export interface SalesPoint {
  label: string;
  retail: number;
  wholesale: number;
  remix: number;
}

export interface DashboardData {
  stats: {
    /** requires pos:read */
    todaySales?: number;
    /** requires reports:read */
    grossMarginPct?: number;
    /** requires reports:read */
    grossMarginTrendPts?: number;
    /** requires pos:read */
    remixSales?: number;
    /** requires pos:read */
    transactionsToday?: number;
    /** requires pos:read */
    avgSaleValue?: number;
    /** requires inventory:read */
    lowStockCount?: number;
    /** requires inventory:read */
    fifoValue?: number;
    /** requires reports:read */
    weekTotal?: number;
    /** requires expenses:read */
    todayExpenseTotal?: number;
    /** requires inventory:read */
    productCount?: number;
    /** requires expenses:read */
    monthExpenseTotal?: number;
    /** requires expenses:read */
    grossProfit?: number;
    /** requires expenses:read */
    netProfit?: number;
    /** requires expenses:read */
    netProfitMarginPct?: number;
    /** requires expenses:read */
    netMarginTrendPts?: number;
    /** requires expenses:read */
    accountsReceivable?: number;
    /** requires expenses:read */
    accountsPayable?: number;
    /** requires expenses:read */
    netCash?: number;
  };
  /** requires pos:read */
  salesTrend?: SalesPoint[];
  alerts: DashboardAlert[];
  /** requires pos:read */
  recentSales?: { id: string; time: string; customer: string; type: string; total: number; payment: string }[];
  /** requires pos:read */
  paymentMix?: { method: string; amount: number; count: number }[];
  /** requires pos:read */
  topProductsToday?: { name: string; qty: number; unit: string; revenue: number }[];
  /** requires inventory:read */
  lowStock?: { id: string; name: string; stockSellable: number; lowStockAt: number; unit: StockUnit }[];
  /** requires inventory:read */
  stockByCategory?: { category: string; value: number; count: number }[];
  /** requires inventory:read */
  stockHealth?: { healthy: number; low: number; out: number };
  /** requires expenses:read */
  expenseByCategory?: { category: string; amount: number }[];
  /** requires expenses:read */
  topReceivables?: { id: string; name: string; balance: number }[];
  /** requires expenses:read */
  topPayables?: { id: string; name: string; balance: number }[];
  moduleRoadmap: { name: string; status: string; priority: number }[];
}

export interface Expense {
  id: string;
  date: string;
  category: string;
  detail: string;
  amount: number;
  status: "pending" | "approved" | "rejected";
}

export type DeliveryChannel = "print" | "email" | "whatsapp" | "sms";
export type DeliveryKind = "receipt" | "quotation" | "custom";
export type DeliveryStatus = "sent" | "failed" | "handoff" | "printed";

export interface DeliveryLogEntryRecord {
  id: string;
  channel: DeliveryChannel;
  kind: DeliveryKind;
  status: DeliveryStatus;
  saleId?: string;
  quotationId?: string;
  receiptNo: string;
  to: string;
  format: string;
  providerId: string;
  error: string;
  preview: string;
  createdAt: string;
}

export interface AppSettings {
  id: string;
  branchName: string;
  currency: string;
  uiLanguage: string;
  invoiceLanguages: string;
  qtyPrecision: number;
  inventoryMethod: string;
  workingHours: string;
  fridayHours: string;
  minMarginGuard: string;
  storeLegalName: string;
  storeAddress: string;
  storePhone: string;
  storeTaxNumber: string;
  receiptLogoUrl: string;
  receiptFooter: string;
  vatPercent: number;
  receiptFormat: "thermal" | "a4";
  autoPrintReceipt: boolean;
  /** Read-only: whether SMS credentials are present on the server. */
  smsConfigured?: boolean;
  quotationNumberPrefix: string;
  quotationDefaultValidityDays: number;
  quotationTermsTemplate: string;
  quotationPaymentTermsPresets: string[];
  quotationDeliveryTermsPresets: string[];
  currentUserName: string;
  currentUserRole: string;
  currentUserRoleLabel: string;
  salespeople: string[];
  activeSalesperson: string;
  integrations: { name: string; status: string }[];
  roles: { role: string; access: string[] }[];
}
