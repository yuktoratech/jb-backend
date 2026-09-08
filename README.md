# jb-backend

## Finalized Product Listing XLSX import

Admin-only endpoints:

- `POST /api/v1/product-imports/preview` — multipart field `file`, XLSX only, maximum 10 MiB.
- `POST /api/v1/product-imports/:batchId/apply` — applies the persisted preview batch owned by the authenticated Admin.

The finalized template uses these headers:

`Product Name`, `Category`, `Sub-category`, `Fit`, `Fabric`, `Description`, `MRP Per Piece`, `Colour`, `Product Code`, `Size Set`, `Status`

`Description` is optional. Blank `Status` defaults to `active`; otherwise it must be `active` or `inactive`. MRP is rupees per piece and is converted to integer paise by the backend. All Category, Sub-category, Fit, Fabric, Colour, and Size Set values must match existing active masters. Sub-category is never inferred and must belong to the selected Category.

Legacy headers `Product title`, `MRP`, and `Size` are accepted as aliases for `Description`, `MRP Per Piece`, and `Size Set`. A legacy `SKU` column is informational and ignored because the backend generates the immutable lowercase SKU. `Pattern/Wash`, `Sleeves`, `Waist`, image, stock, and shelf columns are ignored with preview warnings and are never persisted.

Preview persists normalized rows, generated SKU previews, validation errors, and warnings for seven days. Any invalid row blocks the entire batch. Apply revalidates masters and catalog conflicts, then creates or safely reuses Product, ProductColour, and Variant records in one MongoDB transaction. A transaction-capable MongoDB deployment is required. Product import never creates images, inventory, shelf balances, or stock ledger records. The legacy `/catalog-migrations/*` workflow remains separate.
