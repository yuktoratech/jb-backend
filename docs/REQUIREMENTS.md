# Finalized Requirements Summary

## Roles

Admin creates multiple Wholesalers. Each Wholesaler creates multiple
Retailers. A Retailer belongs to exactly one Wholesaler. Mandatory
account fields: name, phone, email. Forgot/reset password is required.

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

Removed: Sleeves, Waist, Pattern/Wash, separate Product Title.

Product Code is unique per Product+Colour. SKU is lowercase, generated
from product-code + size-set, and immutable.

## Size Sets

Examples: - 32-36 = 32,34,36 = 3 pieces - 32-40 = 32,34,36,38,40 = 5
pieces - S-XXL = S,M,L,XL,XXL = 5 pieces

One piece of each included size. No custom ratios. Users order Sets
only. UI shows Sets and Pieces.

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

Operations: ADD, REMOVE, TRANSFER through Admin and Excel. Maintain
inventory audit history.

## Stock Excel

Columns: SKU, TYPE, QUANTITY, SHELF, TO SHELF (for TRANSFER). It
represents adjustments, not absolute stock.

Validate and preview before applying. Duplicate SKU rows are flagged.

If a missing SKU represents a new Size Set under an existing,
unambiguous Product+Colour, importer may create that Size Set/SKU. It
must not create a completely new Product/Colour.

## Orders

Direct: Wholesaler -\> Pending Admin -\> Confirmed/Cancelled.

Retailer: Retailer -\> Pending Wholesaler -\> Pending Admin -\>
Confirmed/Cancelled.

Wholesaler/Admin may change quantities or remove products. They may not
add products. Preserve original and adjusted values.

Retailer can cancel while Pending Wholesaler only. Once forwarded to
Admin, Retailer cannot directly cancel. Direct Wholesaler order can be
cancelled before Admin confirmation.

Stock is not reserved. Deduct only on final Admin confirmation.

## Checkout

Delivery address required and saved. Multiple addresses supported. No
order notes. No payment gateway. No shipping charge.

## Notifications

Firebase push notifications only. No email order notifications and no
notification-history screen.

## Stack

Flutter Android+iOS; Next.js Admin; Node.js+TypeScript API; MongoDB;
FCM; Hostinger VPS; S3-compatible object storage on Hostinger
infrastructure.
