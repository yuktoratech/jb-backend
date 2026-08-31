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

const calculateReservedShelfTotal = (reservedShelves = []) =>
  reservedShelves.reduce(
    (total, shelfReservation) => total + shelfReservation.quantity,
    0,
  );

const recalculateInventoryTotals = (inventory) => {
  const totalQuantity = calculateShelfTotal(inventory.shelves);
  const reservedShelves = inventory.reservedShelves || [];
  const shelfQuantityByName = new Map(
    inventory.shelves.map(({ shelf, quantity }) => [shelf, quantity]),
  );

  reservedShelves.forEach(({ shelf, quantity }) => {
    const physicalQuantity = shelfQuantityByName.get(shelf) || 0;

    if (quantity > physicalQuantity) {
      throw new RangeError(
        `Reserved quantity on shelf ${shelf} cannot exceed physical stock`,
      );
    }
  });

  const reservedQuantity = calculateReservedShelfTotal(reservedShelves);

  if (!Number.isSafeInteger(totalQuantity) || totalQuantity < 0) {
    throw new RangeError('Shelf stock total is outside the supported range');
  }

  if (!Number.isSafeInteger(reservedQuantity) || reservedQuantity < 0) {
    throw new RangeError('Reserved shelf total is outside the supported range');
  }

  if (reservedQuantity > totalQuantity) {
    throw new RangeError('Reserved quantity cannot exceed physical stock');
  }

  inventory.totalQuantity = totalQuantity;
  inventory.reservedQuantity = reservedQuantity;
  inventory.availableQuantity = totalQuantity - reservedQuantity;
  inventory.status = calculateStockStatus(inventory.availableQuantity);

  return inventory;
};

module.exports = {
  calculateReservedShelfTotal,
  calculateShelfTotal,
  calculateStockStatus,
  normalizeShelf,
  recalculateInventoryTotals,
};
