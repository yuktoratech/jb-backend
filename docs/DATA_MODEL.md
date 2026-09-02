# MongoDB Data Model Baseline

## User

`role`, `name`, `phone`, `emailNormalized`, `passwordHash`,
`wholesalerId` for Retailer, `discountPercent`, `status`, timestamps.

## Category / SubCategory

Dynamic masters. SubCategory belongs to Category.

## Colour / Fit / Fabric

Dynamic masters.

## SizeSet

`label`, explicit `sizes[]`, `pieceCount`, `status`. Do not rely on
parsing the label at runtime.

## Product

`name`, `description`, `categoryId`, `subCategoryId`, `fitId`,
`fabricId`, `mrpPerPieceMinor`, `status`.

## ProductColour

`productId`, `colourId`, `productCode`, `images[]`, `status`.

## SKU

`productId`, `productColourId`, `sizeSetId`, `sku`, `status`. SKU
unique, lowercase, immutable.

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
original/current piece quantity and line financials.

## OrderAudit

Recommended append-only audit of status and item adjustments.

## ImportBatch

filename, uploader, status, row/valid/error counts, validation errors,
timestamps.

## Important indexes

-   SKU.sku unique
-   Order.orderId unique
-   ShelfInventory skuId+shelf unique
-   User normalized email/phone as appropriate
-   User role+wholesalerId
-   Order wholesalerId+status+createdAt
-   Order retailerId+status+createdAt
-   InventoryTransaction skuId+createdAt
