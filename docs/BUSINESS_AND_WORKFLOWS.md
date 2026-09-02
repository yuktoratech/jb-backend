# Business Rules & Workflows

## Order state machine

### Direct Wholesaler

`PENDING_ADMIN -> CONFIRMED | CANCELLED`

### Retailer

`PENDING_WHOLESALER -> PENDING_ADMIN -> CONFIRMED | CANCELLED`

Retailer can cancel only in PENDING_WHOLESALER. Wholesaler may
adjust/cancel/accept. No Retailer re-approval after Wholesaler
adjustment. Admin may adjust/cancel/confirm. No Wholesaler re-approval
after Admin adjustment.

Adjustments are limited to quantity changes and item removal.

## Pricing snapshot

Server calculates and stores: - MRP per piece - pieces per set - Set
MRP - Sets ordered - Gross - discount % - discount amount - taxable
amount - GST 5% - GST amount - final amount

If an order quantity is adjusted, recalculate using the order's
snapshotted MRP/discount, not a later catalog MRP or later account
discount.

## Shelf deduction

Goal: leave the minimum practical number of partially occupied shelves.

Baseline deterministic strategy: 1. Read positive shelf balances for
SKU. 2. Sort ascending by shelf quantity. 3. Exhaust smaller balances
first. 4. Continue until demand is fulfilled. 5. Fail if aggregate stock
is insufficient.

Example: A=10, B=5, demand=7 -\> B-5 and A-2.

## Admin confirmation transaction

1.  Start MongoDB transaction.
2.  Reload order and verify PENDING_ADMIN.
3.  Revalidate current SKU stock.
4.  Calculate shelf allocations.
5.  Update shelf balances with non-negative guards.
6.  Insert inventory ledger records.
7.  Mark order CONFIRMED.
8.  Commit; abort everything on any failure.

No stock reservation occurs before this transaction.

## Push events

-   Retailer submits -\> Wholesaler.
-   Wholesaler accepts/adjusts/cancels -\> Retailer as appropriate.
-   Admin confirms/adjusts/cancels -\> Wholesaler.
-   Relevant final Admin updates also go to Retailer for
    Retailer-originated orders.
