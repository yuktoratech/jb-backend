# Just BLACK B2B --- Codex Instructions

## Project

Build the Just BLACK B2B wholesale clothing platform: - Flutter mobile
app for Wholesaler and Retailer - Next.js Admin Panel - Node.js +
TypeScript API - MongoDB - Firebase Cloud Messaging - S3-compatible
object storage on Hostinger infrastructure

## Source of truth

Before coding, read all files in `docs/`. Do not invent or silently
change business rules. If a task conflicts with the docs, report the
conflict before changing behavior.

## Non-negotiable rules

-   Hierarchy: Admin -\> Wholesaler -\> Retailer.
-   Only Admin creates Wholesalers. Only a Wholesaler creates its
    Retailers.
-   One Retailer belongs to one Wholesaler.
-   One Admin in current scope.
-   MRP is per piece.
-   Users order complete Size Sets only.
-   Inventory quantity is stored in Sets.
-   One fixed account discount applies across all products.
-   Retailer discount is calculated from original MRP, independently of
    Wholesaler discount.
-   GST is 5% after discount.
-   SKU is lowercase and immutable.
-   SKU identifies Product + Colour + Size Set.
-   One SKU can have stock on multiple shelves.
-   Pending orders do not reserve stock.
-   Stock is deducted only on final Admin confirmation.
-   Final confirmation must revalidate stock and atomically confirm
    order + deduct shelves + write inventory ledger.
-   Negative stock is forbidden.
-   Wholesaler/Admin may only change order quantities or remove items;
    they cannot add products.
-   Historical orders retain original/current items and financial
    snapshots.
-   Product images are colour-level.
-   Different colours appear as one Product in mobile listing.
-   Mobile shows In Stock / Out of Stock only.
-   No payment gateway, shipping charge, advanced reporting,
    multi-warehouse, shelf master, custom size ratios, multiple Admin
    roles, or email order notifications.

## Codex workflow

For each task: 1. Read relevant docs and inspect existing code. 2. Give
a short implementation plan. 3. Identify schema/index/API changes. 4.
Implement the smallest coherent change. 5. Add validation and tests. 6.
Run lint/typecheck/tests. 7. Summarize changed files and unresolved
issues.

Never trust client-provided prices, totals, discounts, roles, stock
balances, or shelf allocations.

## Money

Use integer minor units (paise) or another decimal-safe strategy.
Persist MRP/piece, pieces/set, set MRP, set quantity, gross, discount %,
discount amount, taxable amount, GST %, GST amount and final amount.

## MongoDB

Use transaction-capable MongoDB for final Admin confirmation. Enforce
unique SKU, unique Order ID, and unique SKU+shelf inventory identity.
SKU must never be renamed.

## Security

Backend owns authorization. Retailers access only their own data.
Wholesalers access their own data, Retailers and permitted Retailer
orders. Hash passwords, validate uploads, rate-limit sensitive auth
routes, and keep secrets in environment variables.

## Suggested repository

``` text
just-black-b2b/
  AGENTS.md
  docs/
  apps/
    api/
    admin/
    mobile/
  packages/
    shared/
  scripts/
    migration/
```

Adapt to an existing coherent repository instead of rewriting structure
unnecessarily.
