# MongoDB Data Model Baseline

## User

`role`, `name`, `phone`, `emailNormalized`, `passwordHash`,
`wholesalerId` for Retailer, `discountPercent`, `status`, timestamps.
Name, phone and normalized email are mandatory identity fields and cannot be
cleared by update.

## Category / SubCategory

Dynamic masters. SubCategory belongs to Category. Category has an explicit
`sizeFamily` enum (`ALPHA`, `NUMERIC`); a missing value marks legacy data that
must be configured before Product workflows may use it. Category and
SubCategory identity is name-based; neither model exposes or stores a slug.

## Colour / Fit / Fabric

Dynamic name-based masters. They do not expose or store slugs.

## SizeSet

Canonical uppercase `label`, explicit uppercase `sizes[]`, `pieceCount`,
`status`. Product input is parsed once to resolve/create this master; stored
catalog and order behavior use the explicit members and never parse labels at
runtime.

## Product

Canonical uppercase single-token `name`, `description`, `categoryId`, `subCategoryId`, `fitId`,
`fabricId`, `mrpPerPieceMinor`, `status`.

## ProductColour

`productId`, `colourId`, canonical uppercase backend-generated `productCode`,
`images[]`, `status`.

Each image stores an object key and optimized-file metadata. New JPEG, PNG and
WebP inputs are oriented, bounded to 1600 px without upscaling, stripped of
unnecessary metadata and persisted only as quality-90 WebP objects.

## SKU

`productId`, `productColourId`, `sizeSetId`, `sku`, `status`. Every new SKU
is backend-generated, canonical uppercase, unique and immutable; caller input
is never authoritative during manual creation. Client XLSX values are accepted
only when they match the backend-derived logical identifier after normalization.

## ShelfInventory

`skuId`, `shelf`, `quantitySets`, timestamps. Unique compound index:
skuId+shelf.

## InventoryTransaction

Append-only: `skuId`, `type`, `quantitySets`, `fromShelf`, `toShelf`,
before/after values, `source`, `orderId`, `importBatchId`,
`actorUserId`, timestamp.

## Address

`userId`, address fields, `isDefault`, timestamps. Exact address field
breakdown should follow the final UI because only the requirement to
collect/store multiple addresses is currently locked.

## Order

`orderId`, `originRole`, `wholesalerId`, `retailerId`, `status`,
`deliveryAddressSnapshot`, `pricingSnapshot`, `items`, `createdBy`,
`confirmedBy`, timestamps.

Each order item snapshots product name, colour, Size Set, explicit
sizes, pieces/set, MRP/piece, Set MRP, original/current Set quantity,
original/current piece quantity and original/current line gross. The Order
stores the discount/GST percentage snapshots and authoritative current
order-level gross, discount, taxable, GST and final totals. Discount and GST
round at order level; no per-line allocation is defined.

## OrderAudit

Recommended append-only audit of status and item adjustments.

## ImportBatch

For inventory imports: original filename, file hash, uploader, status,
row/valid/error counts, normalized read-only preview rows, validation errors,
applied-by/applied-at data and timestamps. Preview validation processes
projected balances in workbook order; Apply atomically revalidates and uses
the previewed operations.

## Important indexes

-   SKU.sku unique
-   Order.orderId unique
-   ShelfInventory skuId+shelf unique
-   User normalized email/phone as appropriate
-   User role+wholesalerId
-   Order wholesalerId+status+createdAt
-   Order retailerId+status+createdAt
-   InventoryTransaction skuId+createdAt
