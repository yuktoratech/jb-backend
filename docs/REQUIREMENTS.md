# Finalized Requirements Summary

## Roles

Admin creates multiple Wholesalers. Each Wholesaler creates multiple
Retailers. A Retailer belongs to exactly one Wholesaler. Mandatory
account fields: name, phone, email. These fields cannot be cleared by an
account update. Forgot/reset password is required and the reset link is
delivered by email.

After account creation, provide copy-details and open-WhatsApp-chat
behavior for manual credential sharing. No WhatsApp API.

## Pricing

MRP is per piece. Set MRP = MRP per piece x pieces in Size Set. Gross =
Set MRP x ordered Sets. Apply the user's fixed account discount to
Gross. Taxable = Gross - Discount. GST = 5% of Taxable. Final =
Taxable + GST.

Retailer discount is calculated from original MRP and does not cascade
from Wholesaler discount. A Retailer discount may exceed its Wholesaler
discount. Historical orders retain their original financial snapshot.

## Product model

Product -\> Colour -\> Size Set -\> SKU -\> Shelf Stock.

Fields: Product Name, Category, Sub-category, Colour, Size Set,
MRP/piece, Fit, Fabric, Description, Product Code, SKU, colour-level
Images, Quantity in Sets, Shelf.

Removed: Sleeves, Waist, Pattern/Wash, separate Product Title. The client
Product XLSX columns with those names remain accepted and ignored; `Product
title` maps to optional Description.

Product Name, Colour, Size/Size Set label, Product Code and every new SKU are
persisted in canonical uppercase form. Product Name is a single token: any
whitespace is rejected and is never replaced with an underscore. Product Code
is backend-generated per Product+Colour as `<PRODUCT_NAME>_<COLOUR>`, using the
lowest available `_2`, `_3`, ... suffix only for a different logical owner.
Every SKU is backend-generated as `<PRODUCT_CODE>_<SIZE_SET>`, unique and
immutable. API callers cannot choose or override identifiers during manual
creation. Product XLSX-supplied identifiers are normalized and must match the
backend-derived logical identifiers.

## Size Sets

Examples: - 32-36 = 32,34,36 = 3 pieces - 32-40 = 32,34,36,38,40 = 5
pieces - S-2XL = S,M,L,XL,2XL = 5 pieces

One piece of each included size. No custom ratios. Users order Sets
only. UI shows Sets and Pieces.

Category has an explicit required-for-product-workflows `sizeFamily` of
`ALPHA` or `NUMERIC`; existing unconfigured Categories must be configured by
an Admin and are never guessed from their names. Numeric ranges use step 2.
Alpha sizes use `XS,S,M,L,XL,2XL,3XL,4XL,5XL`. Product workflows parse ranges
or explicit lists and atomically reuse or create an identical canonical Size
Set; referenced Size Sets are never mutated. One ProductColour may have
multiple distinct Size Sets.

In the standalone Size Set form, Admin enters only an uppercase label such as
`S-XL` or `30-38`. The backend derives the ordered members and Pieces per Set;
callers cannot submit or manually maintain the member list.

## Catalog

Different colours of one Product display as one mobile Product. Images
are colour-level. Size Sets may differ by colour or be applied to all
colours. Out-of-stock variants stay visible but disabled. Mobile shows
only In Stock / Out of Stock.

Filters: Category, Sub-category, Colour, Size Set, Fit, Fabric, Price.
Sorting includes newest and price. Mobile search does not need Product
Code/SKU search.

## Inventory

Stored in Sets. One SKU can exist on multiple shelves. One warehouse.
Shelf is manually typed; no Shelf Master. No negative stock.

The Admin UI submits ADD, REMOVE and TRANSFER through the XLSX workflow and
has no manual stock-adjustment forms. This UI decision does not remove the
existing protected backend adjustment primitive used by approved internal
workflows. Maintain inventory audit history.

## Stock Excel

Client columns: SKU, QTY, SHELF, ADJUSTMENT TYPE, TO SHELF (for TRANSFER).
The former TYPE and QUANTITY headers remain accepted aliases. It
represents adjustments, not absolute stock.

The workflow is Upload -> read-only Preview -> Verify -> Apply. Rows are
processed in workbook order and previewed projected shelf balances are
authoritative. Repeated SKUs are allowed. Only exact normalized duplicate
operations are rejected with `DUPLICATE_OPERATION`. Any invalid row blocks
the whole batch, and Apply is atomic.

If a row names the exact backend-generated SKU for a missing Size Set under
an existing, unambiguous Product+Colour, the importer may create that SKU.
It must not create a completely new Product or Colour, and the workbook
value cannot override the generated SKU.

The exact Product XLSX headers are Product Name, Product Code, SKU, Category,
Product title, Colour, Size, MRP, Fit, Pattern/Wash, Fabric, Sleeves and Waist.
Sub-category is resolved only when the Category has exactly one active
SubCategory; otherwise the row is blocked with a concise configuration error.
Imports safely upsert active Products, ProductColours and SKUs. A changed MRP
updates the Product-level price for future orders only; historical order
snapshots remain unchanged. Inactive records are never reactivated by import.

Admin Product and ProductColour deactivate actions remain soft archives. A
separate Admin-only permanent Product delete is allowed only without stock,
ledger, Order or import-history dependencies; it removes safely owned catalog
records and ProductColour image objects. Wholesaler and Retailer permanent
delete actions are also separate and dependency-blocked; historical business
records are never cascaded.

ProductColour accepts ordered multi-image uploads. JPEG, PNG and WebP inputs
are optimized by the backend to quality-90 WebP, with correct orientation,
longest side at most 1600 px, no upscaling and unnecessary metadata removed.

## Admin dashboard

The Admin dashboard is operational only: account, product, SKU, stock and
order totals; pending/recent order work; and out-of-stock attention. It
uses complete server pagination totals and must not present a first page as
a complete dataset. Revenue analytics, sales trends, financial charts,
reporting/export and advanced analytics are out of scope.

## Orders

Direct: Wholesaler -\> Pending Admin -\> Confirmed/Cancelled.

Retailer: Retailer -\> Pending Wholesaler -\> Pending Admin -\>
Confirmed/Cancelled.

Wholesaler/Admin may change quantities or remove products. They may not
add products. Preserve original and adjusted values.

Discount and GST are rounded at order level. Order items retain immutable
pricing inputs plus original/current quantities and gross values; arbitrary
per-line discount, taxable, GST or final allocations are not defined.

Retailer can cancel while Pending Wholesaler only. Once forwarded to
Admin, Retailer cannot directly cancel. Direct Wholesaler order can be
cancelled before Admin confirmation.

Stock is not reserved. Deduct only on final Admin confirmation.

## Checkout

Delivery address required and saved. Multiple addresses supported. No
order notes. No payment gateway. No shipping charge.

## Notifications

Firebase push notifications only for order events. Password-recovery email
is the only approved email flow. No email order notifications and no
notification-history screen.

## Stack

Flutter Android+iOS; Next.js Admin; Node.js+TypeScript API; MongoDB;
FCM; Hostinger VPS; S3-compatible object storage on Hostinger
infrastructure.
