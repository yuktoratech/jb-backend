const normalizeAllocationInput = (shelves) => {
  if (!Array.isArray(shelves)) {
    throw new TypeError('Shelves must be an array');
  }

  return shelves
    .filter(({ quantity }) => quantity > 0)
    .map(({ shelf, quantity }) => {
      if (typeof shelf !== 'string' || !shelf) {
        throw new TypeError('Each shelf must have a shelf code');
      }
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new TypeError('Each positive shelf balance must be a whole number');
      }
      return { shelf, quantity };
    });
};

const compareShelfCodes = (left, right) => {
  if (left === right) return 0;
  return left < right ? -1 : 1;
};

const allocateShelfStock = (shelves, requiredQuantity) => {
  if (!Number.isSafeInteger(requiredQuantity) || requiredQuantity <= 0) {
    throw new TypeError('Required quantity must be a positive whole number');
  }

  const positiveShelves = normalizeAllocationInput(shelves);
  const totalAvailable = positiveShelves.reduce((total, entry) => {
    const next = total + entry.quantity;
    if (!Number.isSafeInteger(next)) throw new RangeError('Aggregate stock is too large');
    return next;
  }, 0);

  if (totalAvailable < requiredQuantity) {
    return { allocations: [], sufficient: false, totalAvailable };
  }

  let remaining = requiredQuantity;
  const allocations = [];
  positiveShelves
    .sort((left, right) => left.quantity - right.quantity || compareShelfCodes(left.shelf, right.shelf))
    .forEach(({ shelf, quantity }) => {
      if (remaining === 0) return;
      const deductedQuantity = Math.min(quantity, remaining);
      allocations.push({
        shelf,
        quantity: deductedQuantity,
        previousShelfQuantity: quantity,
        newShelfQuantity: quantity - deductedQuantity,
      });
      remaining -= deductedQuantity;
    });

  return { allocations, sufficient: true, totalAvailable };
};

module.exports = { allocateShelfStock };
