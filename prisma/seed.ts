/**
 * Technic Technologies Electronics ERP — development seed.
 *
 * Builds the demo firm from the handover: one head office + one branch, the
 * full staff roster with 6-digit access codes (900000 = GST-only
 * reconciliation admin), §62 electronics categories and brands, products with
 * variants / serials / IMEIs, and demo customers & suppliers.
 *
 * Safe to re-run: transactional tables are cleared first.
 */
import fs from "node:fs";
import path from "node:path";
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "../src/generated/prisma/client";
import type { UserRole } from "../src/generated/prisma/enums";
import { PERMISSIONS, PERMISSION_DESCRIPTIONS, ROLE_PERMISSIONS } from "../src/lib/rbac";

if (!process.env.DATABASE_URL) {
  try {
    const envFile = fs.readFileSync(path.join(process.cwd(), ".env"), "utf-8");
    for (const line of envFile.split("\n")) {
      const match = line.match(/^\s*([\w_]+)\s*=\s*"?([^"\n]+)"?/);
      if (match?.[1] && match[2]) process.env[match[1]] = match[2];
    }
  } catch {
    // .env is optional
  }
}

const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is not set");

const prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });

const FIRM_ID = "firm_technic_main";
const FY = "26-27";

// ---------------------------------------------------------------------------
// Deterministic helpers
// ---------------------------------------------------------------------------
let seedState = 20260929;
function random(): number {
  seedState = (seedState * 1664525 + 1013904223) % 4294967296;
  return seedState / 4294967296;
}
const pick = <T>(items: readonly T[]): T => items[Math.floor(random() * items.length)];
const randomInt = (min: number, max: number) => Math.floor(random() * (max - min + 1)) + min;
const round2 = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100;

const daysAgo = (days: number, hour = 10) => {
  const date = new Date();
  date.setDate(date.getDate() - days);
  date.setHours(hour, randomInt(0, 59), 0, 0);
  return date;
};

async function clearAll() {
  // Children before parents; cascades handle the rest.
  await prisma.serialHistory.deleteMany();
  await prisma.serialUnit.deleteMany();
  await prisma.warranty.deleteMany();
  await prisma.stockTransaction.deleteMany();
  await prisma.stockAdjustment.deleteMany();
  await prisma.stockTransferLine.deleteMany();
  await prisma.stockTransfer.deleteMany();
  await prisma.payment.deleteMany();
  await prisma.salesReturnLine.deleteMany();
  await prisma.salesReturn.deleteMany();
  await prisma.invoiceLine.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.salesOrderLine.deleteMany();
  await prisma.salesOrder.deleteMany();
  await prisma.quotationLine.deleteMany();
  await prisma.quotation.deleteMany();
  await prisma.goodsReceiptLine.deleteMany();
  await prisma.goodsReceipt.deleteMany();
  await prisma.supplierPayment.deleteMany();
  await prisma.purchaseInvoiceLine.deleteMany();
  await prisma.purchaseInvoice.deleteMany();
  await prisma.purchaseReturnLine.deleteMany();
  await prisma.purchaseReturn.deleteMany();
  await prisma.purchaseOrderLine.deleteMany();
  await prisma.purchaseOrder.deleteMany();
  await prisma.expense.deleteMany();
  await prisma.whatsAppLog.deleteMany();
  await prisma.whatsAppTemplate.deleteMany();
  await prisma.auditLog.deleteMany();
  await prisma.userPermission.deleteMany();
  await prisma.accessCode.deleteMany();
  await prisma.user.deleteMany();
  await prisma.productAttribute.deleteMany();
  await prisma.productVariant.deleteMany();
  await prisma.product.deleteMany();
  await prisma.brand.deleteMany();
  await prisma.category.deleteMany();
  await prisma.customer.deleteMany();
  await prisma.supplier.deleteMany();
  await prisma.documentSequence.deleteMany();
  await prisma.setting.deleteMany();
  await prisma.branch.deleteMany();
  await prisma.firm.deleteMany();
}

async function seedFirm() {
  const firm = await prisma.firm.create({
    data: {
      id: FIRM_ID,
      code: "TECHNIC",
      name: "Technic Technologies Pvt Ltd",
      legalName: "Technic Technologies Private Limited",
      displayName: "Technic Technologies",
      gstin: "29AAKCT1234F1ZP",
      pan: "AAKCT1234F",
      addressLine: "42, Electronics City Phase 1, Hosur Road",
      city: "Bengaluru",
      state: "Karnataka",
      stateCode: "29",
      pincode: "560100",
      phone: "08049001200",
      email: "sales@technic.example",
      website: "www.technic.example",
      financialYear: FY,
      status: "ACTIVE",
    },
  });

  const headOffice = await prisma.branch.create({
    data: {
      firmId: FIRM_ID,
      code: "HO",
      name: "Head Office — Electronics City",
      type: "HEAD_OFFICE",
      addressLine: "42, Electronics City Phase 1, Hosur Road",
      city: "Bengaluru",
      state: "Karnataka",
      stateCode: "29",
      pincode: "560100",
      phone: "08049001200",
      email: "sales@technic.example",
      gstin: "29AAKCT1234F1ZP",
    },
  });

  const branch = await prisma.branch.create({
    data: {
      firmId: FIRM_ID,
      code: "BR1",
      name: "MG Road Store",
      type: "BRANCH",
      addressLine: "18, MG Road",
      city: "Bengaluru",
      state: "Karnataka",
      stateCode: "29",
      pincode: "560001",
      phone: "08049001201",
      email: "mgroad@technic.example",
      gstin: "29AAKCT1234F1ZP",
    },
  });

  return { firm, headOffice, branch };
}

async function seedPermissions() {
  const codes = Object.values(PERMISSIONS);

  for (const code of codes) {
    await prisma.permission.upsert({
      where: { code },
      create: {
        code,
        module: code.split(".")[0],
        description: PERMISSION_DESCRIPTIONS[code] ?? code,
      },
      update: { description: PERMISSION_DESCRIPTIONS[code] ?? code },
    });
  }

  const permissions = await prisma.permission.findMany({ select: { id: true, code: true } });
  const idByCode = new Map(permissions.map((entry) => [entry.code, entry.id]));

  await prisma.rolePermission.deleteMany();
  const rows = Object.entries(ROLE_PERMISSIONS).flatMap(([role, granted]) =>
    granted
      .map((code) => idByCode.get(code))
      .filter((id): id is string => Boolean(id))
      .map((permissionId) => ({ role: role as UserRole, permissionId })),
  );
  await prisma.rolePermission.createMany({ data: rows, skipDuplicates: true });
  console.log(`  ${codes.length} permissions, ${rows.length} role grants`);
}

async function seedUsers(branchIds: { ho: string; br1: string }) {
  const definitions: {
    code: string;
    name: string;
    email: string;
    login: string;
    role: UserRole;
    branchId: string;
  }[] = [
    { code: "EMP0001", name: "Arun Kumar (Super Admin)", email: "superadmin@technic.example", login: "900001", role: "PLATFORM_ADMIN", branchId: branchIds.ho },
    { code: "EMP0000", name: "GST Reconciliation Admin", email: "gst.admin@technic.example", login: "900000", role: "ADMIN", branchId: branchIds.ho },
    { code: "EMP0002", name: "Deepa Rao", email: "admin@technic.example", login: "900002", role: "ADMIN", branchId: branchIds.ho },
    { code: "EMP0003", name: "Suresh Menon", email: "manager@technic.example", login: "900003", role: "MANAGER", branchId: branchIds.ho },
    { code: "EMP0004", name: "Rekha Pillai", email: "accountant@technic.example", login: "900004", role: "ACCOUNTANT", branchId: branchIds.ho },
    { code: "EMP0005", name: "Anjali Verma", email: "sales@technic.example", login: "900005", role: "SALES_STAFF", branchId: branchIds.br1 },
    { code: "EMP0006", name: "Rahul Bhat", email: "purchase@technic.example", login: "900006", role: "PURCHASE_STAFF", branchId: branchIds.ho },
    { code: "EMP0007", name: "Lalita Devi", email: "inventory@technic.example", login: "900007", role: "INVENTORY_MANAGER", branchId: branchIds.ho },
    { code: "EMP0008", name: "Gautam Bose", email: "viewer@technic.example", login: "900008", role: "VIEWER", branchId: branchIds.ho },
  ];

  const users: { id: string; role: UserRole; name: string }[] = [];
  for (const def of definitions) {
    const user = await prisma.user.create({
      data: {
        firmId: FIRM_ID,
        employeeCode: def.code,
        name: def.name,
        email: def.email,
        phone: `9${randomInt(100000000, 999999999)}`,
        accessCode: def.login,
        role: def.role,
        branchId: def.branchId,
        status: "ACTIVE",
        // The GST reconciliation admin (900000) gets the GST-only reporting
        // view; every other user sees the full combined transaction stream.
        accessView: def.login === "900000" ? "GST_ONLY" : "COMBINED",
      },
      select: { id: true, role: true, name: true },
    });
    users.push(user);
  }
  console.log(`  ${users.length} users — logins 900000..900008`);
  return users;
}

async function seedCatalogue(branchIds: { ho: string; br1: string }) {
  const categoryNames = [
    "Mobile Phones", "Laptops", "Televisions", "Home Appliances",
    "Accessories", "Computers & Peripherals", "Audio", "Cameras",
  ];
  const categories = await Promise.all(
    categoryNames.map((name) =>
      prisma.category.create({ data: { firmId: FIRM_ID, name } }),
    ),
  );
  const cat = (name: string) => categories.find((c) => c.name === name)!.id;

  const brandNames = ["Samsung", "Apple", "Lenovo", "Sony", "LG", "Boat", "Canon", "Dell"];
  const brands = await Promise.all(
    brandNames.map((name) => prisma.brand.create({ data: { firmId: FIRM_ID, name } })),
  );
  const brand = (name: string) => brands.find((b) => b.name === name)!.id;

  interface ProductPlan {
    name: string;
    sku: string;
    category: string;
    brand: string;
    hsn: string;
    gst: number;
    cost: number;
    sell: number;
    mrp: number;
    warranty: number;
    trackSerials: boolean;
    trackImei?: boolean;
    attrs: { name: string; value: string }[];
    variants?: { name: string; sku: string; cost: number; sell: number; warranty?: number }[];
  }

  const plans: ProductPlan[] = [
    {
      name: "Galaxy S24 5G", sku: "MOB-SGS24-256", category: "Mobile Phones", brand: "Samsung",
      hsn: "85171300", gst: 18, cost: 62000, sell: 74999, mrp: 79999, warranty: 12,
      trackSerials: true, trackImei: true,
      attrs: [{ name: "Display", value: "6.2\" AMOLED" }, { name: "Storage", value: "256 GB" }, { name: "RAM", value: "8 GB" }],
    },
    {
      name: "iPhone 15", sku: "MOB-IP15-128", category: "Mobile Phones", brand: "Apple",
      hsn: "85171300", gst: 18, cost: 68000, sell: 79900, mrp: 89900, warranty: 12,
      trackSerials: true, trackImei: true,
      attrs: [{ name: "Display", value: "6.1\" Super Retina XDR" }, { name: "Storage", value: "128 GB" }],
    },
    {
      name: "ThinkPad E14 Gen 6", sku: "LAP-TP-E14", category: "Laptops", brand: "Lenovo",
      hsn: "84713010", gst: 18, cost: 52000, sell: 64990, mrp: 74990, warranty: 36,
      trackSerials: true,
      attrs: [{ name: "Processor", value: "Core i5-1335U" }, { name: "RAM", value: "16 GB" }, { name: "Storage", value: "512 GB SSD" }],
      variants: [
        { name: "16GB / 512GB", sku: "LAP-TP-E14-16-512", cost: 52000, sell: 64990, warranty: 36 },
        { name: "16GB / 1TB", sku: "LAP-TP-E14-16-1TB", cost: 58000, sell: 72990, warranty: 36 },
      ],
    },
    {
      name: "Bravia 55\" 4K TV", sku: "TV-SONY-55X75", category: "Televisions", brand: "Sony",
      hsn: "85287232", gst: 28, cost: 48000, sell: 62990, mrp: 74990, warranty: 12,
      trackSerials: true,
      attrs: [{ name: "Panel", value: "LED 4K" }, { name: "Size", value: "55 inch" }],
    },
    {
      name: "Refrigerator 253L Double Door", sku: "APP-LG-253RF", category: "Home Appliances", brand: "LG",
      hsn: "84181011", gst: 18, cost: 22000, sell: 28990, mrp: 34990, warranty: 12,
      trackSerials: true,
      attrs: [{ name: "Capacity", value: "253 L" }, { name: "Rating", value: "3 Star" }],
    },
    {
      name: "Air Fryer 4L", sku: "APP-PHILIPS-4L", category: "Home Appliances", brand: "LG",
      hsn: "85166030", gst: 18, cost: 6200, sell: 8999, mrp: 10995, warranty: 24,
      trackSerials: false,
      attrs: [{ name: "Capacity", value: "4 L" }, { name: "Power", value: "1400 W" }],
    },
    {
      name: "Wireless Earbuds Airdopes 141", sku: "ACC-BOAT-141", category: "Accessories", brand: "Boat",
      hsn: "85183000", gst: 18, cost: 890, sell: 1499, mrp: 2990, warranty: 12,
      trackSerials: false,
      attrs: [{ name: "Playback", value: "42 hours" }, { name: "Bluetooth", value: "5.1" }],
    },
    {
      name: "Wireless Mouse MX Master 3S", sku: "ACC-LOGI-MX3S", category: "Computers & Peripherals", brand: "Dell",
      hsn: "84716060", gst: 18, cost: 6800, sell: 9950, mrp: 11995, warranty: 12,
      trackSerials: false,
      attrs: [{ name: "Sensor", value: "8000 DPI" }],
    },
    {
      name: "Portable Bluetooth Speaker", sku: "AUD-SONY-XB13", category: "Audio", brand: "Sony",
      hsn: "85182200", gst: 18, cost: 3200, sell: 4990, mrp: 5990, warranty: 12,
      trackSerials: true,
      attrs: [{ name: "Output", value: "13 W" }, { name: "Water resistance", value: "IP67" }],
    },
    {
      name: "EOS R50 Mirrorless Camera", sku: "CAM-CAN-R50", category: "Cameras", brand: "Canon",
      hsn: "85258900", gst: 18, cost: 58000, sell: 69990, mrp: 74995, warranty: 24,
      trackSerials: true,
      attrs: [{ name: "Sensor", value: "24.2 MP APS-C" }, { name: "Video", value: "4K 30fps" }],
    },
  ];

  const created: { id: string; name: string; sku: string; trackSerials: boolean; trackImei: boolean; sellingPrice: unknown; purchasePrice: unknown; warrantyMonths: number; variants: { id: string; name: string; sku: string }[] }[] = [];

  for (const plan of plans) {
    const product = await prisma.product.create({
      data: {
        firmId: FIRM_ID,
        name: plan.name,
        sku: plan.sku,
        categoryId: cat(plan.category),
        brandId: brand(plan.brand),
        hsnCode: plan.hsn,
        gstRate: plan.gst,
        purchasePrice: plan.cost,
        sellingPrice: plan.sell,
        mrp: plan.mrp,
        minSellingPrice: round2(plan.cost * 1.05),
        warrantyMonths: plan.warranty,
        trackSerials: plan.trackSerials,
        trackImei: Boolean(plan.trackImei),
        lowStockQty: 5,
        branchId: branchIds.ho,
        barcode: `89${randomInt(10000000000, 99999999999)}`,
        attributes: { create: plan.attrs },
        variants: {
          create: (plan.variants ?? []).map((variant) => ({
            name: variant.name,
            sku: variant.sku,
            purchasePrice: variant.cost,
            sellingPrice: variant.sell,
            mrp: variant.sell,
            warrantyMonths: variant.warranty ?? plan.warranty,
          })),
        },
      },
      include: { variants: true },
    });
    created.push({
      id: product.id,
      name: product.name,
      sku: product.sku,
      trackSerials: product.trackSerials,
      trackImei: product.trackImei,
      sellingPrice: product.sellingPrice,
      purchasePrice: product.purchasePrice,
      warrantyMonths: product.warrantyMonths,
      variants: product.variants.map((v) => ({ id: v.id, name: v.name, sku: v.sku })),
    });
  }

  console.log(`  ${created.length} products, ${created.reduce((sum, p) => sum + p.variants.length, 0)} variants`);
  return created;
}

async function seedSuppliers() {
  const suppliers = await Promise.all(
    [
      { code: "SUP00001", name: "Redington India Ltd", gstin: "29AAACR1234A1Z5", city: "Bengaluru", state: "Karnataka", paymentTerms: "Net 30", creditDays: 30 },
      { code: "SUP00002", name: "Ingram Micro Distribution", gstin: "27AAACI2345B1Z8", city: "Mumbai", state: "Maharashtra", paymentTerms: "Net 45", creditDays: 45 },
      { code: "SUP00003", name: "South Tech Distributors", gstin: "29AAESD5678C1Z2", city: "Bengaluru", state: "Karnataka", paymentTerms: "Advance", creditDays: 0 },
    ].map((supplier) => prisma.supplier.create({ data: { firmId: FIRM_ID, ...supplier } })),
  );
  console.log(`  ${suppliers.length} suppliers`);
  return suppliers;
}

async function seedCustomers(branchIds: { ho: string; br1: string }) {
  const names = [
    "Ravi Sharma", "Priya Nair", "Vikram Reddy", "Meera Iyer", "Arjun Patel",
    "Kavya Rao", "Zenith Infotech Pvt Ltd", "Nimbus Traders",
  ];
  const customers: { id: string; name: string; phone: string; state: string | null }[] = [];
  let index = 1;
  for (const name of names) {
    const isBusiness = name.includes("Ltd") || name.includes("Traders");
    const customer = await prisma.customer.create({
      data: {
        code: `CUS${String(index).padStart(5, "0")}`,
        firmId: FIRM_ID,
        branchId: index % 2 === 0 ? branchIds.br1 : branchIds.ho,
        name,
        phone: `9${randomInt(100000000, 999999999)}`,
        type: isBusiness ? "BUSINESS" : "RETAIL",
        gstin: isBusiness ? `29AAKCS${String(1000 + index)}Z1` : null,
        city: "Bengaluru",
        state: index === names.length ? "Maharashtra" : "Karnataka",
        creditLimit: isBusiness ? 200000 : 0,
      },
      select: { id: true, name: true, phone: true, state: true },
    });
    customers.push(customer);
    index += 1;
  }
  console.log(`  ${customers.length} customers`);
  return customers;
}

async function seedStockAndSales(
  products: Awaited<ReturnType<typeof seedCatalogue>>,
  branchId: string,
  adminId: string,
  salesId: string,
) {
  // Opening stock via purchase invoices.
  let piCounter = 0;
  for (const product of products) {
    const quantity = product.trackSerials ? randomInt(3, 6) : randomInt(8, 20);
    piCounter += 1;
    const piNumber = `TT/PI/${FY}/${String(piCounter).padStart(4, "0")}`;
    const cost = Number(product.purchasePrice);
    const lineTotal = round2(cost * quantity);
    const invoice = await prisma.purchaseInvoice.create({
      data: {
        invoiceNumber: piNumber,
        firmId: FIRM_ID,
        branchId,
        supplierId: (await prisma.supplier.findFirst({ where: { firmId: FIRM_ID } }))!.id,
        taxMode: "GST",
        status: "PAID",
        invoiceDate: daysAgo(30),
        subtotal: lineTotal,
        taxableAmount: lineTotal,
        cgstAmount: round2(lineTotal * 0.09),
        sgstAmount: round2(lineTotal * 0.09),
        total: round2(lineTotal * 1.18),
        amountPaid: round2(lineTotal * 1.18),
        createdById: adminId,
        lines: {
          create: {
            productId: product.id,
            description: product.name,
            quantity,
            unitPrice: cost,
            gstRate: 18,
            lineTotal: round2(lineTotal * 1.18),
          },
        },
      },
    });

    const serials = product.trackSerials
      ? Array.from({ length: quantity }, (_, i) =>
          `${product.sku}-${String(randomInt(100000, 999999))}${i}`,
        )
      : [];

    await prisma.stockTransaction.create({
      data: {
        firmId: FIRM_ID,
        branchId,
        productId: product.id,
        type: "PURCHASE_IN",
        quantity,
        balanceAfter: quantity,
        unitCost: cost,
        reference: piNumber,
        documentType: "PURCHASE_INVOICE",
        documentId: invoice.id,
        userId: adminId,
        createdAt: daysAgo(30),
      },
    });

    for (const serial of serials) {
      const unit = await prisma.serialUnit.create({
        data: {
          firmId: FIRM_ID,
          productId: product.id,
          serialNumber: serial,
          imei1: product.trackImei ? `35${randomInt(100000000000, 999999999999)}` : null,
          status: "IN_STOCK",
          branchId,
          purchaseInvoiceId: invoice.id,
          purchasePrice: cost,
          sellingPrice: Number(product.sellingPrice),
          purchasedAt: daysAgo(30),
        },
      });
      await prisma.serialHistory.create({
        data: {
          serialUnitId: unit.id,
          eventType: "PURCHASE_IN",
          toStatus: "IN_STOCK",
          reference: piNumber,
          documentId: invoice.id,
          userId: adminId,
        },
      });
    }
  }

  // Two GST invoices + two non-GST bills.
  const customers = await prisma.customer.findMany({
    where: { firmId: FIRM_ID },
    select: { id: true, name: true, phone: true, state: true },
    take: 4,
  });

  for (const [index, customer] of customers.entries()) {
    const product = products[index % products.length];
    const quantity = 1;
    const sell = Number(product.sellingPrice);
    const isGst = index % 2 === 0;
    const mode = isGst ? "GST" : "NON_GST";
    // Catalogue prices are GST-inclusive shelf prices (matches the live tax
    // engine): extract the embedded tax instead of adding it on top.
    const taxable = isGst ? round2(sell / 1.18) : sell;
    const cgst = isGst ? round2(taxable * 0.09) : 0;
    const sgst = isGst ? round2(taxable * 0.09) : 0;
    const total = sell;

    let invoiceNumber: string;
    if (isGst) {
      invoiceNumber = `TT/GST/${FY}/000${index + 1}`;
    } else {
      invoiceNumber = `TT/NG/${FY}/000${index + 1}`;
    }

    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber,
        kind: isGst ? "TAX_INVOICE" : "NON_GST_BILL",
        firmId: FIRM_ID,
        branchId,
        customerId: customer.id,
        taxMode: mode,
        financialYear: FY,
        status: "PAID",
        billToName: customer.name,
        billToPhone: customer.phone,
        placeOfSupply: customer.state ?? "Karnataka",
        invoiceDate: daysAgo(randomInt(2, 15)),
        subtotal: sell,
        taxableAmount: taxable,
        cgstAmount: cgst,
        sgstAmount: sgst,
        roundOff: 0,
        totalAmount: total,
        amountPaid: total,
        amountDue: 0,
        createdById: salesId,
        lines: {
          create: {
            productId: product.id,
            description: product.name,
            quantity,
            unitPrice: sell,
            gstRate: isGst ? 18 : 0,
            taxableValue: taxable,
            cgstAmount: cgst,
            sgstAmount: sgst,
            lineTotal: total,
          },
        },
      },
    });

    // Stock out + serial sale + warranty.
    await prisma.stockTransaction.create({
      data: {
        firmId: FIRM_ID,
        branchId,
        productId: product.id,
        type: "SALE_OUT",
        quantity: -quantity,
        balanceAfter: 0,
        reference: invoiceNumber,
        documentType: "INVOICE",
        documentId: invoice.id,
        userId: salesId,
      },
    });

    if (product.trackSerials) {
      const unit = await prisma.serialUnit.findFirst({
        where: { firmId: FIRM_ID, productId: product.id, status: "IN_STOCK" },
      });
      if (unit) {
        await prisma.serialUnit.update({
          where: { id: unit.id },
          data: {
            status: "SOLD",
            soldInvoiceId: invoice.id,
            soldAt: new Date(),
            sellingPrice: sell,
          },
        });
        await prisma.serialHistory.create({
          data: {
            serialUnitId: unit.id,
            eventType: "SOLD",
            fromStatus: "IN_STOCK",
            toStatus: "SOLD",
            reference: invoiceNumber,
            documentId: invoice.id,
            userId: salesId,
          },
        });
        if (product.warrantyMonths > 0) {
          const start = new Date();
          const end = new Date(start);
          end.setMonth(end.getMonth() + product.warrantyMonths);
          await prisma.warranty.create({
            data: {
              firmId: FIRM_ID,
              productId: product.id,
              serialUnitId: unit.id,
              customerId: customer.id,
              invoiceId: invoice.id,
              branchId,
              serialNumber: unit.serialNumber,
              imei: unit.imei1,
              warrantyStart: start,
              warrantyEnd: end,
              warrantyMonths: product.warrantyMonths,
              warrantyType: "STANDARD",
              status: "ACTIVE",
            },
          });
        }
      }
    }

    await prisma.payment.create({
      data: {
        paymentNumber: `TT/PAY/${FY}/000${index + 1}`,
        firmId: FIRM_ID,
        branchId,
        direction: "CUSTOMER_IN",
        status: "PAID",
        customerId: customer.id,
        invoiceId: invoice.id,
        amount: total,
        method: index % 2 === 0 ? "UPI" : "CASH",
        receivedById: salesId,
        paidAt: daysAgo(randomInt(2, 15)),
      },
    });

    await prisma.customer.update({
      where: { id: customer.id },
      data: {
        invoiceCount: { increment: 1 },
        totalBilled: { increment: total },
        lastInvoiceAt: new Date(),
      },
    });
  }

  console.log(`  opening stock + ${customers.length} demo invoices (GST & non-GST)`);
}

async function seedSettings() {
  const settings = [
    { key: "app_name", value: "Technic Technologies ERP", category: "general" },
    { key: "company_bank_details", value: "Technic Technologies Pvt Ltd\nA/C 50200012345678, HDFC Bank, Electronics City Branch\nIFSC HDFC0001234", category: "company" },
    { key: "sequence_invoice_gst", value: "TT/GST/{FY}/", category: "documents" },
    { key: "sequence_invoice_non_gst", value: "TT/NG/{FY}/", category: "documents" },
  ];
  for (const setting of settings) {
    await prisma.setting.create({ data: { firmId: FIRM_ID, ...setting } });
  }
}

async function main() {
  console.log("Seeding Technic Technologies ERP…");
  await clearAll();
  await seedPermissions();

  const { headOffice, branch } = await seedFirm();
  const users = await seedUsers({ ho: headOffice.id, br1: branch.id });
  const admin = users.find((u) => u.role === "PLATFORM_ADMIN")!;

  await seedSettings();
  const products = await seedCatalogue({ ho: headOffice.id, br1: branch.id });
  await seedSuppliers();
  await seedCustomers({ ho: headOffice.id, br1: branch.id });
  const sales = users.find((u) => u.role === "SALES_STAFF")!;
  await seedStockAndSales(products, headOffice.id, admin.id, sales.id);

  // Advance the per-mode document counters past every number this seed
  // created by hand (TT/GST + TT/NG invoices, TT/PI purchase invoices,
  // TT/PAY payments) so the first real document can never collide with
  // seed data. Both modes are advanced to the overall maximum where the
  // seed numbers documents without separating modes (purchase invoices,
  // payments); a small numbering gap is harmless, a collision is not.
  const setCounter = async (
    documentType: string,
    taxMode: "GST" | "NON_GST",
    value: number,
    financialYear: string = FY,
  ) => {
    await prisma.documentSequence.upsert({
      where: {
        firmId_documentType_taxMode_financialYear: {
          firmId: FIRM_ID,
          documentType,
          taxMode,
          financialYear,
        },
      },
      create: { firmId: FIRM_ID, documentType, taxMode, financialYear, value },
      update: { value },
    });
  };

  const trailingNumber = (docNumber: string) => {
    const parsed = Number(docNumber.split("/").pop());
    return Number.isFinite(parsed) ? parsed : 0;
  };

  const seedInvoices = await prisma.invoice.findMany({
    where: { firmId: FIRM_ID, invoiceNumber: { startsWith: "TT/" } },
    select: { invoiceNumber: true, kind: true },
  });
  for (const accessMode of ["GST", "NON_GST"] as const) {
    const max = Math.max(
      0,
      ...seedInvoices
        .filter((i) => (accessMode === "GST" ? i.kind === "TAX_INVOICE" : i.kind === "NON_GST_BILL"))
        .map((i) => trailingNumber(i.invoiceNumber)),
    );
    if (max > 0) await setCounter("invoice", accessMode, max);
  }

  const seedPurchaseInvoices = await prisma.purchaseInvoice.findMany({
    where: { firmId: FIRM_ID },
    select: { invoiceNumber: true },
  });
  const piMax = Math.max(0, ...seedPurchaseInvoices.map((pi) => trailingNumber(pi.invoiceNumber)));
  if (piMax > 0) {
    await setCounter("purchase_invoice", "GST", piMax);
    await setCounter("purchase_invoice", "NON_GST", piMax);
  }

  const seedPayments = await prisma.payment.findMany({
    where: { firmId: FIRM_ID },
    select: { paymentNumber: true },
  });
  const payMax = Math.max(0, ...seedPayments.map((p) => trailingNumber(p.paymentNumber)));
  if (payMax > 0) {
    await setCounter("payment", "GST", payMax);
    await setCounter("payment", "NON_GST", payMax);
  }

  // Customer/supplier codes are CUS00001/SUP00001 on a financialYear-independent
  // sequence ("ALL"). Sync those counters too, otherwise the first record
  // created after seeding collides with a hand-created seed code.
  const seedCustomersForSync = await prisma.customer.findMany({
    where: { firmId: FIRM_ID },
    select: { code: true },
  });
  const customerMax = Math.max(
    0,
    ...seedCustomersForSync.map((c) => Number(c.code.replace(/^CUS/, ""))),
  );
  if (customerMax > 0) await setCounter("customer", "NON_GST", customerMax, "ALL");

  const seedSuppliersForSync = await prisma.supplier.findMany({
    where: { firmId: FIRM_ID },
    select: { code: true },
  });
  const supplierMax = Math.max(
    0,
    ...seedSuppliersForSync.map((s) => Number(s.code.replace(/^SUP/, ""))),
  );
  if (supplierMax > 0) await setCounter("supplier", "NON_GST", supplierMax, "ALL");

  console.log("Seed complete.");
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
