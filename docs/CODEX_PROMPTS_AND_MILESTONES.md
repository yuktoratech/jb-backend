# Codex Prompts & Milestones

## First Codex prompt

Read `AGENTS.md` and every file under `docs/`. Treat them as
authoritative.

Inspect the repository and report: 1. recommended project/module
structure, 2. environment variables/dependencies, 3. MongoDB
schema/index plan, 4. API module boundaries, 5. Milestone 2
implementation sequence, 6. contradictions or missing decisions.

Do not implement business logic until you have reported conflicts.

## Catalog prompt

Implement Product, Colour, Size Set and immutable SKU management
according to the docs. Include colour-level images, MRP per piece,
dynamic masters, validation, indexes and tests.

## Inventory prompt

Implement inventory according to the docs: SKU+shelf balances,
ADD/REMOVE/TRANSFER, no negative stock, ledger, Excel
validate/preview/apply, and missing Size Set/SKU creation only under an
existing Product+Colour.

## Order prompt

Implement the finalized order workflows. Server calculates pricing,
discount and GST; stores snapshots; preserves original/current item
quantities; and does not reserve stock.

## Confirmation prompt

Implement final Admin confirmation with a MongoDB transaction,
current-stock revalidation, deterministic shelf allocation, guarded
non-negative updates, ledger entries and concurrency tests. Never trust
client totals or shelf allocation.

## Review prompt

Audit the implementation against `AGENTS.md` and docs. Report
business-rule violations, missing authorization, pricing/GST mistakes,
SKU mutability, stock race conditions, transaction gaps, missing audit
history and insufficient tests. Avoid unrelated refactors.

# Milestone 1

Deliver: 1. Final Requirement v2. 2. Workflow & Business Rule sign-off.
3. Product/SKU/Inventory mapping. 4. Sample migration validation report.
5. Technical solution summary. 6. Client Milestone 1 approval/sign-off.

Milestone 1 is planning/data-validation sign-off, not software UAT.

Suggested client approval text:

> We confirm that the finalized requirements, role hierarchy,
> product/colour/size-set/SKU rules, pricing/discount/GST rules, order
> workflow, inventory/shelf rules and migration mapping have been
> reviewed and approved as the development baseline for the Just BLACK
> B2B platform. Development may proceed to the next milestone. Later
> requirements outside this approved baseline may be treated as change
> requests.

# Milestone 2 implementation order

1.  Repo/backend foundation and auth.
2.  Role authorization.
3.  Dynamic masters.
4.  Product/Colour/SizeSet/SKU.
5.  Object-storage image upload.
6.  Wholesaler management + discount.
7.  Shelf inventory + ledger.
8.  Manual ADD/REMOVE/TRANSFER.
9.  Excel validation/preview/apply.
10. Order model and workflows.
11. Atomic Admin confirmation.
12. Push backend integration.
13. Admin screens.
14. Initial migration and validation.

# Milestone 5

Formal client software UAT belongs here after Admin, backend and mobile
are integrated.
