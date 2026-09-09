# jb-backend

Node.js API for the Just BLACK B2B Admin, Wholesaler, and Retailer
workflows. MongoDB transactions are required for atomic inventory imports
and final Admin order confirmation.

## Account and password-recovery configuration

Copy `.env.example` to `.env` and provide real environment-specific values.
`ADMIN_NAME`, `ADMIN_EMAIL`, `ADMIN_PHONE`, and `ADMIN_PASSWORD` are all
required by `npm run seed:admin`; the seed never invents an identity value.

Password recovery stores only a short-lived token hash and delivers the
one-time reset link by email. Configure `PASSWORD_RESET_URL`, `EMAIL_FROM`,
and the `SMTP_*` variables documented in `.env.example`. Order-event email
is not implemented; those notifications remain Firebase push only.

## Finalized Inventory XLSX import

Admin-only endpoints:

- `POST /api/v1/inventory/imports/preview` — uploads an XLSX workbook and
  persists its read-only, server-authoritative preview.
- `POST /api/v1/inventory/imports/:batchId/apply` — revalidates and applies a
  valid preview atomically.

The Admin workflow is Upload -> Preview -> Verify -> Apply. Rows are handled
in workbook order against projected shelf balances. Repeated SKUs are valid;
only exact normalized duplicate operations are rejected with
`DUPLICATE_OPERATION`. Any invalid row blocks the complete batch. There is no
manual stock-adjustment form in the Admin frontend.

## Finalized Product Listing XLSX import

Admin-only endpoints:

- `POST /api/v1/product-imports/preview` — multipart field `file`, XLSX only, maximum 10 MiB.
- `POST /api/v1/product-imports/:batchId/apply` — applies the persisted preview batch owned by the authenticated Admin.

The finalized template uses these headers:

`Product Name`, `Category`, `Sub-category`, `Fit`, `Fabric`, `Description`, `MRP Per Piece`, `Colour`, `Product Code`, `Size Set`, `Status`

`Description` is optional. Blank `Status` defaults to `active`; otherwise it must be `active` or `inactive`. MRP is rupees per piece and is converted to integer paise by the backend. All Category, Sub-category, Fit, Fabric, Colour, and Size Set values must match existing active masters. Sub-category is never inferred and must belong to the selected Category.

Legacy headers `Product title`, `MRP`, and `Size` are accepted as aliases for `Description`, `MRP Per Piece`, and `Size Set`. A legacy `SKU` column is informational and ignored because the backend generates the immutable lowercase SKU. `Pattern/Wash`, `Sleeves`, `Waist`, image, stock, and shelf columns are ignored with preview warnings and are never persisted.

Preview persists normalized rows, generated SKU previews, validation errors, and warnings for seven days. Any invalid row blocks the entire batch. Apply revalidates masters and catalog conflicts, then creates or safely reuses Product, ProductColour, and Variant records in one MongoDB transaction. A transaction-capable MongoDB deployment is required. Product import never creates images, inventory, shelf balances, or stock ledger records. The legacy `/catalog-migrations/*` workflow remains separate.
