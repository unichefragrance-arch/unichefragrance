import mongoose, { Schema, models, model } from "mongoose";

const ProductSchema = new Schema(
  {
    sku: { type: String, required: true, unique: true, trim: true },
    name: { type: String, required: true, trim: true },
    nameAr: String,
    category: { type: String, required: true },
    unit: { type: String, enum: ["pcs", "ml", "g", "kg"], required: true },
    sellPrice: { type: Number, required: true, default: 0 },
    wholesalePrice: { type: Number, default: 0 },
    minMarginPct: { type: Number, required: true, default: 0 },
    costFifo: { type: Number, required: true, default: 0 },
    brand: { type: String, default: "" },
    concentration: { type: String, default: "" },
    gender: { type: String, default: "" },
    size: { type: String, default: "" },
    collection: { type: String, default: "" },
    notes: { type: String, default: "" },
    itemType: {
      type: String,
      enum: ["finished", "packaging", "raw"],
      default: "finished",
    },
    importBatchId: { type: String, index: true, default: null },
    stockSellable: { type: Number, required: true, default: 0 },
    stockTester: { type: Number, required: true, default: 0 },
    stockSample: { type: Number, required: true, default: 0 },
    stockPersonal: { type: Number, required: true, default: 0 },
    lowStockAt: { type: Number, required: true, default: 0 },
    isQuickButton: { type: Boolean, default: false },
    tags: [{ type: String }],
    lastSoldAt: Date,
  },
  { timestamps: true },
);

const FifoLayerSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true },
    supplierName: { type: String, required: true },
    purchaseDate: { type: Date, required: true },
    qtyRemaining: { type: Number, required: true },
    /** Quantity received into this layer (audit; absent on layers created before it existed). */
    originalQty: { type: Number },
    unitCost: { type: Number, required: true },
    currency: { type: String, required: true, default: "OMR" },
    /** purchase = goods receipt; production = finished goods from a production order */
    source: {
      type: String,
      enum: ["purchase", "production"],
      default: "purchase",
    },
    productionOrderId: {
      type: Schema.Types.ObjectId,
      ref: "ProductionOrder",
      default: null,
    },
    /** Purchase order whose goods receipt created this layer (audit trail). */
    purchaseOrderId: {
      type: Schema.Types.ObjectId,
      ref: "PurchaseOrder",
      default: null,
    },
  },
  { timestamps: true },
);
// Speeds POS FIFO consume: oldest positive layer per product
FifoLayerSchema.index({ productId: 1, qtyRemaining: 1, purchaseDate: 1 });

const CustomerSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true, trim: true, index: true },
    email: String,
    /** CRM-01: captured once confirmed with the customer, not required at intake. */
    address: { type: String, default: "" },
    vatNumber: { type: String, default: "" },
    /** CRM-12 minimum-intake field alongside name/phone. */
    productsRequested: [{ type: String }],
    notes: { type: String, default: "" },
    preferences: [{ type: String }],
    totalPurchases: { type: Number, default: 0 },
    lastVisit: { type: Date },
    creditBalance: { type: Number, default: 0 },
    hasCustomFormula: { type: Boolean, default: false },
  },
  { timestamps: true },
);

const SupplierSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    phone: { type: String, required: true },
    currency: { type: String, required: true, default: "OMR" },
    creditLimit: { type: Number, default: 0 },
    outstanding: { type: Number, default: 0 },
    lastPurchase: { type: Date },
    avgLeadDays: { type: Number, default: 0 },
  },
  { timestamps: true },
);

const FormulaComponentSchema = new Schema(
  {
    productId: { type: String, required: true },
    productName: { type: String, required: true },
    qty: { type: Number, required: true, min: 0 },
    unit: { type: String, enum: ["pcs", "ml", "g", "kg"], required: true },
  },
  { _id: false },
);

const FormulaAuditSchema = new Schema(
  {
    at: { type: Date, required: true },
    by: String,
    action: {
      type: String,
      enum: ["created", "updated", "status_changed", "restored"],
      required: true,
    },
    detail: String,
    fromStatus: String,
    toStatus: String,
    fromVersion: Number,
    toVersion: Number,
  },
  { _id: false },
);

const FormulaVersionSchema = new Schema(
  {
    version: { type: Number, required: true },
    name: { type: String, required: true },
    type: { type: String, enum: ["remix", "oil", "bakhoor"], required: true },
    status: {
      type: String,
      enum: ["draft", "approved", "rejected", "archived"],
      required: true,
    },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerName: String,
    yieldMl: { type: Number, required: true },
    components: [FormulaComponentSchema],
    notes: String,
    savedAt: { type: Date, required: true },
    savedBy: String,
  },
  { _id: false },
);

const MaterialsReservationSchema = new Schema(
  {
    active: { type: Boolean, default: false },
    reservedAt: Date,
    lines: [
      {
        productId: { type: String, required: true },
        productName: { type: String, required: true },
        qty: { type: Number, required: true, min: 0 },
        unit: { type: String, default: "ml" },
      },
    ],
  },
  { _id: false },
);

const FormulaSchema = new Schema(
  {
    name: { type: String, required: true },
    type: { type: String, enum: ["remix", "oil", "bakhoor"], required: true },
    status: {
      type: String,
      enum: ["draft", "approved", "rejected", "archived"],
      default: "draft",
    },
    version: { type: Number, required: true, default: 1, min: 1 },
    versions: { type: [FormulaVersionSchema], default: [] },
    history: { type: [FormulaAuditSchema], default: [] },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerName: String,
    yieldMl: { type: Number, required: true },
    components: [FormulaComponentSchema],
    notes: String,
    approvedAt: Date,
    approvedBy: String,
    /** BLD-12: auto material reservation — active only when approved. */
    materialsReservation: {
      type: MaterialsReservationSchema,
      default: () => ({ active: false, lines: [] }),
    },
  },
  { timestamps: true },
);
FormulaSchema.index({ updatedAt: -1 });
FormulaSchema.index({ status: 1, updatedAt: -1 });
FormulaSchema.index({ customerId: 1, status: 1 });
FormulaSchema.index({ type: 1, status: 1 });

const PurchaseOrderLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    sku: { type: String, default: "" },
    qtyOrdered: { type: Number, required: true, min: 0 },
    qtyReceived: { type: Number, required: true, default: 0, min: 0 },
    /** Qty already pushed into FifoLayer — prevents double-apply on re-save. */
    qtyFifoApplied: { type: Number, required: true, default: 0, min: 0 },
    unitCost: { type: Number, required: true, min: 0 },
  },
  { _id: true },
);

const PurchaseOrderSchema = new Schema(
  {
    supplierId: { type: Schema.Types.ObjectId, ref: "Supplier", required: true },
    supplierName: { type: String, required: true },
    date: { type: Date, required: true },
    status: {
      type: String,
      enum: ["draft", "ordered", "received", "partial"],
      default: "draft",
    },
    currency: { type: String, required: true, default: "OMR" },
    /** Sum of line qty × unitCost, before VAT. */
    subtotal: { type: Number, required: true, default: 0 },
    /** PUR-VAT: VAT added on top of subtotal, editable per PO — 0 disables tax.
     *  Schema default stays 0 so purchase orders saved before this field existed
     *  don't get retroactively mislabeled as VAT-inclusive; the create form defaults to 5. */
    vatPercent: { type: Number, required: true, default: 0 },
    vatAmount: { type: Number, required: true, default: 0 },
    /** subtotal + vatAmount — what's actually owed to the supplier. */
    total: { type: Number, required: true, default: 0 },
    itemCount: { type: Number, required: true, default: 0 },
    lines: { type: [PurchaseOrderLineSchema], default: [] },
    notes: String,
    /** PUR-12: set once, first time status reaches "received" — feeds Supplier.avgLeadDays. */
    receivedAt: { type: Date, default: null },
    /** BRN-08 branch isolation */
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", index: true },
    branchName: String,
  },
  { timestamps: true },
);

/** QTN-02/QTN-09: catalog product or custom-blend (formula/bottle/packaging/design) line. */
const QuotationLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, required: true },
    qty: { type: Number, required: true, min: 0 },
    unitLabel: { type: String, required: true },
    unitPrice: { type: Number, required: true, min: 0 },
    lineType: {
      type: String,
      enum: [
        "ready",
        "remix",
        "oil",
        "refill",
        "packaging",
        "wholesale",
        "custom_blend",
      ],
      required: true,
    },
    /** QTN-09 custom-blend refs — recipe itself stays secret (BLD-04), only the link is stored. */
    formulaId: { type: Schema.Types.ObjectId, ref: "Formula" },
    formulaName: { type: String, default: "" },
    packagingProductIds: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    bottleNote: { type: String, default: "" },
    designNote: { type: String, default: "" },
    charges: { type: Number, default: 0, min: 0 },
    notes: { type: String, default: "" },
  },
  { _id: false },
);

/** QTN-07: customer LPO/PO supporting file, stored inline (no external storage configured). */
const QuotationAttachmentSchema = new Schema(
  {
    name: { type: String, required: true },
    mimeType: { type: String, required: true },
    dataBase64: { type: String, required: true },
    uploadedAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

/** QTN-05 immutable snapshot of a quotation before a revision is applied. */
const QuotationVersionSchema = new Schema(
  {
    version: { type: Number, required: true },
    status: { type: String, required: true },
    lines: { type: [QuotationLineSchema], default: [] },
    subtotal: { type: Number, required: true, default: 0 },
    vatPercent: { type: Number, required: true, default: 0 },
    vatAmount: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true, default: 0 },
    paymentTerms: String,
    deliveryTerms: String,
    validityDays: Number,
    termsText: String,
    notes: String,
    savedAt: { type: Date, required: true },
    savedBy: String,
  },
  { _id: false },
);

/** QTN-05 append-only audit log (separate from the version snapshots above). */
const QuotationHistorySchema = new Schema(
  {
    at: { type: Date, required: true },
    by: String,
    action: {
      type: String,
      enum: [
        "created",
        "updated",
        "status_changed",
        "revised",
        "shared",
        "converted",
        "customer_decision",
      ],
      required: true,
    },
    detail: String,
    fromStatus: String,
    toStatus: String,
    fromVersion: Number,
    toVersion: Number,
  },
  { _id: false },
);

const QuotationSchema = new Schema(
  {
    number: { type: String, required: true, unique: true },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerName: { type: String, required: true },
    customerPhone: { type: String, required: true },
    customerEmail: { type: String, default: "" },
    customerTrn: { type: String, default: "" },
    customerAddress: { type: String, default: "" },
    status: {
      type: String,
      enum: [
        "draft",
        "sent",
        "revised",
        "approved",
        "rejected",
        "expired",
        "converted",
      ],
      default: "draft",
    },
    date: { type: Date, required: true },
    expiry: { type: Date, required: true },

    lines: { type: [QuotationLineSchema], default: [] },
    /** Server-computed from lines + vatPercent — never trust client totals. */
    subtotal: { type: Number, required: true, default: 0 },
    vatPercent: { type: Number, required: true, default: 0 },
    vatAmount: { type: Number, required: true, default: 0 },
    total: { type: Number, required: true, default: 0 },

    /** QTN-07 */
    customerPoNumber: { type: String, default: "" },
    attachments: { type: [QuotationAttachmentSchema], default: [] },

    /** QTN-03 */
    paymentTerms: { type: String, default: "" },
    deliveryTerms: { type: String, default: "" },
    validityDays: { type: Number, default: 14 },
    termsText: { type: String, default: "" },
    notes: { type: String, default: "" },

    /** QTN-02 signature capture on approval */
    signatureDataUrl: { type: String, default: "" },
    signedByName: { type: String, default: "" },
    signedAt: Date,

    /** QTN-05 */
    version: { type: Number, required: true, default: 1, min: 1 },
    versions: { type: [QuotationVersionSchema], default: [] },
    history: { type: [QuotationHistorySchema], default: [] },

    /** QTN-10 public approval link */
    approvalToken: { type: String, index: true, sparse: true, unique: true },
    approvalTokenExpiresAt: Date,
    publicViewedAt: Date,
    customerDecision: { type: String, enum: ["approved", "rejected"] },
    customerDecisionAt: Date,
    customerDecisionNote: { type: String, default: "" },

    convertedToSaleId: { type: Schema.Types.ObjectId, ref: "Sale" },
    /** BRN-08 branch isolation */
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", index: true },
    branchName: String,
  },
  { timestamps: true },
);

const SaleLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product" },
    name: { type: String, required: true },
    qty: { type: Number, required: true },
    unitLabel: { type: String, required: true },
    unitPrice: { type: Number, required: true },
    lineType: {
      type: String,
      enum: ["ready", "remix", "oil", "refill", "packaging", "wholesale"],
      required: true,
    },
    bomNote: String,
    deductMl: Number,
    oilProductId: { type: Schema.Types.ObjectId, ref: "Product" },
    oilMl: Number,
    formulaId: { type: Schema.Types.ObjectId, ref: "Formula" },
    packagingProductIds: [{ type: Schema.Types.ObjectId, ref: "Product" }],
    /** POS-110: custom-blend notes carried over from the quotation. */
    bottleNote: String,
    designNote: String,
    /** POS-069: item-level discount as entered + the amount it took off. */
    discountType: { type: String, enum: ["percent", "amount"] },
    discountValue: Number,
    discountAmount: { type: Number, default: 0 },
  },
  { _id: false },
);

const InventoryDeductionBatchSchema = new Schema(
  {
    layerId: { type: Schema.Types.ObjectId, ref: "FifoLayer", required: true },
    qty: { type: Number, required: true },
    unitCost: { type: Number, required: true },
    purchaseDate: { type: Date, required: true },
  },
  { _id: false },
);

const InventoryDeductionSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    qty: { type: Number, required: true },
    reason: { type: String, required: true },
    lineIndex: { type: Number, required: true },
    costTotal: { type: Number, required: true, default: 0 },
    batches: [InventoryDeductionBatchSchema],
  },
  { _id: false },
);

const SaleSchema = new Schema(
  {
    customerPhone: { type: String, required: true },
    customerName: { type: String, default: "Walk-in" },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    salesperson: { type: String, required: true, trim: true, index: true },
    payment: {
      type: String,
      enum: ["cash", "card", "bank", "credit", "mixed"],
      required: true,
    },
    /** Only set when payment === "mixed" — how the total splits across methods. */
    paymentBreakdown: [
      {
        _id: false,
        method: { type: String, enum: ["cash", "card", "bank", "credit"], required: true },
        amount: { type: Number, required: true },
      },
    ],
    status: {
      type: String,
      enum: ["completed", "held", "void"],
      default: "completed",
    },
    /** POS-104: the quotation this sale was converted from. */
    quotationId: { type: Schema.Types.ObjectId, ref: "Quotation", default: undefined },
    quotationNumber: { type: String, default: undefined },
    /**
     * VAT added on top of the price (quotations). Absent on POS sales, whose
     * shelf prices already include VAT at the store rate.
     */
    vatPercent: { type: Number, default: undefined },
    vatAmount: { type: Number, default: undefined },
    /** POS-098: on a completed sale — the held bill it was resumed from. */
    resumedFromId: { type: Schema.Types.ObjectId, ref: "Sale", default: undefined },
    /**
     * On a held bill closed by checkout (status void) — the sale it became.
     * A void bill without it was discarded.
     */
    completedSaleId: { type: Schema.Types.ObjectId, ref: "Sale", default: undefined },
    lines: [SaleLineSchema],
    /** Gross, before discounts. */
    subtotal: { type: Number, required: true },
    /** POS-070: invoice-level discount, applied after line discounts. */
    invoiceDiscountType: { type: String, enum: ["percent", "amount"] },
    invoiceDiscountValue: Number,
    invoiceDiscountAmount: { type: Number, default: 0 },
    /** Line + invoice discounts. total = subtotal − discountTotal (revenue for profit). */
    discountTotal: { type: Number, default: 0 },
    /** Logged-in user who applied the discount (salesperson is a Settings name, not a login). */
    discountAppliedBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      name: String,
      role: String,
    },
    /** POS-071: set when the discount exceeded the cashier's limit and was approved. */
    discountApprovedBy: {
      userId: { type: Schema.Types.ObjectId, ref: "User" },
      name: String,
      role: String,
    },
    total: { type: Number, required: true },
    saleType: {
      type: String,
      enum: ["Retail", "Wholesale", "Remix", "Oil", "Refill", "Mixed"],
      default: "Retail",
    },
    idempotencyKey: {
      type: String,
      sparse: true,
      unique: true,
      index: true,
    },
    inventoryDeductions: [InventoryDeductionSchema],
    /** BRN-08 branch isolation */
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", index: true },
    branchName: String,
  },
  { timestamps: true },
);

const DeliveryLogSchema = new Schema(
  {
    channel: {
      type: String,
      enum: ["print", "email", "whatsapp", "sms"],
      required: true,
      index: true,
    },
    kind: {
      type: String,
      enum: ["receipt", "quotation", "custom"],
      required: true,
    },
    status: {
      type: String,
      enum: ["sent", "failed", "handoff", "printed"],
      required: true,
    },
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", index: true },
    quotationId: { type: Schema.Types.ObjectId, ref: "Quotation" },
    receiptNo: { type: String, default: "" },
    to: { type: String, default: "" },
    format: { type: String, default: "" },
    providerId: { type: String, default: "" },
    error: { type: String, default: "" },
    preview: { type: String, default: "" },
  },
  { timestamps: true },
);

const ExpenseSchema = new Schema(
  {
    date: { type: Date, required: true },
    category: { type: String, required: true },
    detail: { type: String, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["pending", "approved", "rejected"],
      default: "pending",
    },
    /** BRN-08 branch isolation */
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", index: true },
    branchName: String,
  },
  { timestamps: true },
);

const AppSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true },
    branchName: { type: String, default: "Main Store — Muscat" },
    currency: { type: String, default: "OMR" },
    uiLanguage: { type: String, default: "English" },
    invoiceLanguages: { type: String, default: "English + Arabic" },
    qtyPrecision: { type: Number, default: 3 },
    inventoryMethod: { type: String, default: "FIFO" },
    workingHours: { type: String, default: "10:00 – 22:00" },
    fridayHours: { type: String, default: "16:30 – 22:00" },
    minMarginGuard: { type: String, default: "Admin password required" },
    storeLegalName: { type: String, default: "" },
    storeAddress: { type: String, default: "" },
    storePhone: { type: String, default: "" },
    storeTaxNumber: { type: String, default: "" },
    receiptLogoUrl: { type: String, default: "" },
    receiptFooter: {
      type: String,
      default: "Thank you for shopping with UNICH.",
    },
    /** Shelf prices are VAT-inclusive; 0 disables the tax breakdown on receipts. */
    vatPercent: { type: Number, default: 0 },
    receiptFormat: {
      type: String,
      enum: ["thermal", "a4"],
      default: "thermal",
    },
    autoPrintReceipt: { type: Boolean, default: false },
    /** QTN-03/QTN-05 quotation defaults */
    quotationNumberPrefix: { type: String, default: "QT" },
    quotationDefaultValidityDays: { type: Number, default: 14 },
    quotationTermsTemplate: {
      type: String,
      default:
        "Prices are valid for the quoted validity period. Goods once sold on custom-blend orders are not returnable. Delivery timelines are estimates and may vary.",
    },
    quotationPaymentTermsPresets: {
      type: [String],
      default: [
        "50% advance, balance on delivery",
        "Net 30",
        "Cash on delivery",
      ],
    },
    quotationDeliveryTermsPresets: {
      type: [String],
      default: [
        "Ex-store pickup",
        "Delivery within 3–5 business days",
        "Delivery within UAE only",
      ],
    },
    currentUserName: { type: String, default: "Ahmad Ibrahim" },
    currentUserRole: { type: String, default: "manager" },
    currentUserRoleLabel: { type: String, default: "Manager" },
    salespeople: {
      type: [{ type: String, trim: true }],
      default: ["Ahmad Ibrahim"],
    },
    activeSalesperson: {
      type: String,
      trim: true,
      default: "Ahmad Ibrahim",
    },
    pettyCashFloat: { type: Number, default: 500 },
    integrations: [
      {
        name: String,
        status: String,
      },
    ],
    roles: [
      {
        role: String,
        access: [String],
      },
    ],
  },
  { timestamps: true },
);

const ImportBatchRowSchema = new Schema(
  {
    rowNumber: { type: Number, required: true },
    action: {
      type: String,
      enum: ["create", "update", "error"],
      required: true,
    },
    sku: { type: String, default: "" },
    payload: { type: Schema.Types.Mixed },
    errorReason: { type: String, default: "" },
    previousProductSnapshot: { type: Schema.Types.Mixed },
    createdProductId: { type: Schema.Types.ObjectId, ref: "Product" },
    priceFloorViolation: { type: Boolean, default: false },
  },
  { _id: false },
);

const ImportBatchSchema = new Schema(
  {
    batchId: { type: String, required: true, unique: true, index: true },
    userName: { type: String, required: true },
    fileName: { type: String, required: true },
    status: {
      type: String,
      enum: ["staged", "committed", "undone"],
      default: "staged",
    },
    total: { type: Number, default: 0 },
    created: { type: Number, default: 0 },
    updated: { type: Number, default: 0 },
    failed: { type: Number, default: 0 },
    priceFloorCount: { type: Number, default: 0 },
    rawRows: { type: Schema.Types.Mixed, default: [] },
    rows: [ImportBatchRowSchema],
  },
  { timestamps: true },
);

const ProductionConsumeBatchSchema = new Schema(
  {
    layerId: { type: Schema.Types.ObjectId, ref: "FifoLayer", required: true },
    qty: { type: Number, required: true },
    unitCost: { type: Number, required: true },
    purchaseDate: { type: Date, required: true },
  },
  { _id: false },
);

const ProductionPlannedLineSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    qty: { type: Number, required: true, min: 0 },
    unit: { type: String, default: "ml" },
    reason: { type: String, required: true },
  },
  { _id: false },
);

const ProductionConsumptionSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    qty: { type: Number, required: true },
    reason: { type: String, required: true },
    costTotal: { type: Number, required: true, default: 0 },
    batches: [ProductionConsumeBatchSchema],
  },
  { _id: false },
);

const ProductionBatchSchema = new Schema(
  {
    batchNumber: { type: String, required: true },
    producedAt: { type: Date, required: true },
    outputProductId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    outputProductName: { type: String, required: true },
    outputSku: { type: String, default: "" },
    outputQty: { type: Number, required: true, min: 0 },
    outputUnit: { type: String, required: true },
    unitCost: { type: Number, required: true, default: 0 },
    totalMaterialCost: { type: Number, required: true, default: 0 },
    fifoLayerId: { type: Schema.Types.ObjectId, ref: "FifoLayer" },
  },
  { _id: false },
);

const ProductionOrderSchema = new Schema(
  {
    orderNumber: { type: String, required: true, unique: true, index: true },
    formulaId: { type: Schema.Types.ObjectId, ref: "Formula", required: true },
    formulaName: { type: String, required: true },
    formulaType: {
      type: String,
      enum: ["remix", "oil", "bakhoor"],
      required: true,
    },
    formulaVersion: { type: Number, required: true, default: 1 },
    /** Number of formula runs (e.g. bottles to produce). */
    qty: { type: Number, required: true, min: 1 },
    /** BLD-06 expected yield (formula.yieldMl × qty). */
    yieldMl: { type: Number, required: true, default: 0 },
    /** BLD-06 actual measured yield on complete. */
    actualYieldMl: { type: Number },
    /** BLD-06: actual − expected. */
    varianceMl: { type: Number },
    /** BLD-06: shortfall when actual < expected. */
    wastageMl: { type: Number },
    /** BLD-06: |variance| ≤ ±5 ml. */
    withinTolerance: { type: Boolean },
    status: {
      type: String,
      enum: ["draft", "completed", "cancelled"],
      default: "draft",
      index: true,
    },
    /** Set while one request completes the order — stops concurrent completions double-consuming stock. */
    completingAt: { type: Date, default: null },
    oilProductId: { type: Schema.Types.ObjectId, ref: "Product" },
    oilProductName: String,
    outputProductId: {
      type: Schema.Types.ObjectId,
      ref: "Product",
      required: true,
    },
    outputProductName: { type: String, required: true },
    outputSku: { type: String, default: "" },
    outputUnit: { type: String, required: true },
    /** Finished goods qty to add on complete. */
    outputQty: { type: Number, required: true, min: 0 },
    plannedLines: { type: [ProductionPlannedLineSchema], default: [] },
    consumption: { type: [ProductionConsumptionSchema], default: [] },
    batch: { type: ProductionBatchSchema, default: null },
    notes: String,
    createdBy: String,
    completedAt: Date,
    completedBy: String,
    cancelledAt: Date,
  },
  { timestamps: true },
);
ProductionOrderSchema.index({ createdAt: -1 });
ProductionOrderSchema.index({ status: 1, createdAt: -1 });

export const Product = models.Product || model("Product", ProductSchema);
export const FifoLayer = models.FifoLayer || model("FifoLayer", FifoLayerSchema);
export const Customer = models.Customer || model("Customer", CustomerSchema);
export const Supplier = models.Supplier || model("Supplier", SupplierSchema);
export const Formula = models.Formula || model("Formula", FormulaSchema);
export const PurchaseOrder =
  models.PurchaseOrder || model("PurchaseOrder", PurchaseOrderSchema);
export const Quotation = models.Quotation || model("Quotation", QuotationSchema);
export const Sale = models.Sale || model("Sale", SaleSchema);
export const Expense = models.Expense || model("Expense", ExpenseSchema);
export const DeliveryLog =
  models.DeliveryLog || model("DeliveryLog", DeliveryLogSchema);
export const AppSettings =
  models.AppSettings || model("AppSettings", AppSettingsSchema);
export const ImportBatch =
  models.ImportBatch || model("ImportBatch", ImportBatchSchema);
export const ProductionOrder =
  models.ProductionOrder || model("ProductionOrder", ProductionOrderSchema);

/** INV-07 audit trail for stock adjustments / wastage. */
const InventoryAdjustmentSchema = new Schema(
  {
    productId: { type: Schema.Types.ObjectId, ref: "Product", required: true },
    productName: { type: String, required: true },
    qty: { type: Number, required: true, min: 0 },
    direction: { type: String, enum: ["in", "out"], required: true },
    reason: {
      type: String,
      enum: ["wastage_cost", "wastage_customer", "restock", "adjustment"],
      required: true,
    },
    /** INV-07: cost vs customer-paid liability. */
    liability: {
      type: String,
      enum: ["cost", "customer_paid"],
    },
    costTotal: { type: Number, default: 0 },
    customerId: { type: Schema.Types.ObjectId, ref: "Customer" },
    customerName: String,
    customerPhone: String,
    saleId: { type: Schema.Types.ObjectId, ref: "Sale" },
    expenseId: { type: Schema.Types.ObjectId, ref: "Expense" },
    notes: String,
    createdBy: String,
    /** BRN-08 branch isolation */
    branchId: { type: Schema.Types.ObjectId, ref: "Branch", index: true },
    branchName: String,
    /** Client key per submission (scoped to the user) — a resent request is applied once. */
    idempotencyKey: String,
    idempotencyOwner: String,
    /** True while the stock movement for this keyed request is still running. */
    pending: Boolean,
  },
  { timestamps: true },
);
InventoryAdjustmentSchema.index({ createdAt: -1 });
InventoryAdjustmentSchema.index(
  { idempotencyOwner: 1, idempotencyKey: 1 },
  { unique: true, partialFilterExpression: { idempotencyKey: { $type: "string" } } },
);
InventoryAdjustmentSchema.index({ productId: 1, createdAt: -1 });

export const InventoryAdjustment =
  models.InventoryAdjustment ||
  model("InventoryAdjustment", InventoryAdjustmentSchema);

/** BRN-08: physical / logical store for branch isolation. */
const BranchSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    code: { type: String, required: true, unique: true, trim: true, uppercase: true },
    active: { type: Boolean, default: true },
  },
  { timestamps: true },
);

/** BRN-08: login identity with role + branch. */
const UserSchema = new Schema(
  {
    name: { type: String, required: true, trim: true },
    email: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      lowercase: true,
      index: true,
    },
    passwordHash: { type: String, required: true },
    role: {
      type: String,
      enum: ["owner", "manager", "cashier", "accountant", "inventory", "branch_manager"],
      required: true,
      index: true,
    },
    roleLabel: { type: String, required: true },
    branchId: {
      type: Schema.Types.ObjectId,
      ref: "Branch",
      default: null,
      index: true,
    },
    branchName: { type: String, default: null },
    active: { type: Boolean, default: true, index: true },
    lastLoginAt: { type: Date, default: null },
  },
  { timestamps: true },
);

export const Branch = models.Branch || model("Branch", BranchSchema);
export const User = models.User || model("User", UserSchema);

/**
 * POS-072: single-use manager approval for an over-limit discount, bound to
 * the cashier and a fingerprint of the exact cart. Expires after a few minutes.
 */
const DiscountApprovalSchema = new Schema(
  {
    token: { type: String, required: true, unique: true },
    actorUserId: { type: String, required: true },
    approverUserId: { type: String, required: true },
    approverName: { type: String, required: true },
    approverRole: { type: String, required: true },
    fingerprint: { type: String, required: true },
    maxDiscountPct: { type: Number, required: true },
    discountTotal: { type: Number, required: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    saleId: { type: Schema.Types.ObjectId, ref: "Sale", default: null },
  },
  { timestamps: true },
);
// Purged 30 days after expiry — each sale keeps its own discountApprovedBy.
DiscountApprovalSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 30 * 24 * 3600 });

export const DiscountApproval =
  models.DiscountApproval || model("DiscountApproval", DiscountApprovalSchema);

/**
 * Server-side record of each login session (the cookie carries only its sid).
 * Logout revokes one session; the proxy rejects revoked/expired sessions and
 * sessions whose user was deactivated or had role/branch changed.
 */
const AuthSessionSchema = new Schema(
  {
    sid: { type: String, required: true, unique: true },
    userId: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true },
);
AuthSessionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const AuthSession = models.AuthSession || model("AuthSession", AuthSessionSchema);

/** Login rate-limit sliding window — one document per key (ip:X or email:X). */
const RateLimitSchema = new Schema({
  key: { type: String, required: true, unique: true },
  attempts: [{ type: Date }],
  expiresAt: { type: Date, required: true },
});
RateLimitSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const RateLimit = models.RateLimit || model("RateLimit", RateLimitSchema);

/** General security/activity audit trail — who did what, when, from where. */
const AuditLogSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: "User" },
    userName: String,
    userEmail: String,
    role: String,
    branchId: { type: Schema.Types.ObjectId, ref: "Branch" },
    branchName: String,
    action: { type: String, required: true },
    entityType: { type: String, required: true },
    entityId: String,
    detail: String,
    ip: String,
  },
  { timestamps: true },
);
AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ entityType: 1, entityId: 1 });
AuditLogSchema.index({ userId: 1, createdAt: -1 });

export const AuditLog = models.AuditLog || model("AuditLog", AuditLogSchema);

/**
 * Header notification bell — one document per distinct alert condition
 * (e.g. "product X below threshold"), synced from live business state
 * (src/lib/notifications/alerts.ts) each time the bell is opened.
 * `dedupeKey` is stable per condition so re-syncing updates the existing
 * row instead of spamming duplicates; `resolved` is set once the
 * underlying condition clears (stock restocked, balance paid, etc.).
 */
const NotificationSchema = new Schema(
  {
    dedupeKey: { type: String, required: true, unique: true },
    type: { type: String, required: true },
    title: { type: String, required: true },
    detail: { type: String, default: "" },
    severity: {
      type: String,
      enum: ["info", "warning", "critical"],
      default: "info",
    },
    read: { type: Boolean, default: false },
    resolved: { type: Boolean, default: false },
  },
  { timestamps: true },
);
NotificationSchema.index({ resolved: 1, read: 1, createdAt: -1 });

export const Notification =
  models.Notification || model("Notification", NotificationSchema);
