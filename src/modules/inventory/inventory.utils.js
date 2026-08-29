const MAX_SHELF_LENGTH = 100;

const normalizeShelf = (value) => {
  if (typeof value !== 'string') {
    throw new TypeError('Shelf must be a string');
  }

  const normalized = value.trim().toUpperCase();

  if (!normalized) {
    throw new TypeError('Shelf is required');
  }

  if (/[\u0000-\u001f\u007f]/.test(normalized)) {
    throw new TypeError('Shelf contains unsupported control characters');
  }

  if (normalized.length > MAX_SHELF_LENGTH) {
    throw new TypeError(
      `Shelf cannot exceed ${MAX_SHELF_LENGTH} characters`,
    );
  }

  return normalized;
};

const calculateStockStatus = (availableQuantity) =>
  availableQuantity > 0 ? 'in_stock' : 'out_of_stock';

const calculateShelfTotal = (shelves) =>
  shelves.reduce((total, shelfStock) => total + shelfStock.quantity, 0);

const recalculateInventoryTotals = (inventory) => {
  const totalQuantity = calculateShelfTotal(inventory.shelves);
  const reservedQuantity = inventory.reservedQuantity || 0;

  if (!Number.isSafeInteger(totalQuantity) || totalQuantity < 0) {
    throw new RangeError('Shelf stock total is outside the supported range');
  }

  if (reservedQuantity > totalQuantity) {
    throw new RangeError('Reserved quantity cannot exceed physical stock');
  }

  inventory.totalQuantity = totalQuantity;
  inventory.availableQuantity = totalQuantity - reservedQuantity;
  inventory.status = calculateStockStatus(inventory.availableQuantity);

  return inventory;
};

module.exports = {
  calculateShelfTotal,
  calculateStockStatus,
  normalizeShelf,
  recalculateInventoryTotals,
};
