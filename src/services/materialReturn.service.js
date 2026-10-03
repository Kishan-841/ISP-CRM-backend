/**
 * Moving recovered material back into store stock.
 *
 * A StorePurchaseOrderItem batch IS the inventory - the delivery assign screen
 * reads from it. Returning a serial means appending it to a batch's
 * serialNumbers[] and keeping the counts in step with that array.
 *
 * Extracted from store.controller.js so the material-return approval flow and
 * lead cancellation share one implementation instead of two that drift.
 *
 * Every function takes a Prisma transaction client as its first argument so
 * callers control the transaction boundary.
 */

/**
 * Pick the batch a returned serial should land in.
 *
 * GOOD  -> the batch it was assigned from when that batch is reliably known,
 *          else a PO-less RETURN batch. assignedFromPOItemId records only the
 *          FIRST source PO, so for a multi-PO assignment it may not be this
 *          serial's true origin - fall back rather than credit a batch it never
 *          came from.
 * FAULTY -> a per-product FAULTY batch, never the original: POItemStatus is
 *          per-BATCH, so flagging the original would quarantine its good
 *          serials too.
 */
const resolveTargetBatch = async (tx, { deliveryItem, productId, condition, userId }) => {
  if (condition === 'GOOD') {
    if (deliveryItem?.assignedFromPOItemId) {
      const origin = await tx.storePurchaseOrderItem.findFirst({
        where: { id: deliveryItem.assignedFromPOItemId, productId, status: 'IN_STORE' }
      });
      if (origin) return origin;
    }
    const loose = await tx.storePurchaseOrderItem.findFirst({
      where: { poId: null, productId, status: 'IN_STORE' }
    });
    if (loose) return loose;
  } else {
    const faulty = await tx.storePurchaseOrderItem.findFirst({
      where: { poId: null, productId, status: 'FAULTY' }
    });
    if (faulty) return faulty;
  }

  return tx.storePurchaseOrderItem.create({
    data: {
      productId,
      poId: null,
      quantity: 0,
      serialNumbers: [],
      receivedQuantity: 0,
      status: condition === 'GOOD' ? 'IN_STORE' : 'FAULTY',
      addedToStoreAt: new Date(),
      directEntryById: userId
    }
  });
};

/**
 * Put one serial back into stock.
 * @returns {Promise<string>} the id of the batch it landed in
 */
export const returnSerialToStock = async (tx, { deliveryItem, productId, serialNumber, condition, userId }) => {
  const targetBatch = await resolveTargetBatch(tx, { deliveryItem, productId, condition, userId });

  // Set semantics: a serial already present is left alone rather than
  // duplicated, which would invent inventory that does not exist.
  const nextSerials = [...new Set([...(targetBatch.serialNumbers || []), serialNumber])];

  await tx.storePurchaseOrderItem.update({
    where: { id: targetBatch.id },
    data: {
      serialNumbers: nextSerials,
      receivedQuantity: nextSerials.length,
      quantity: nextSerials.length
    }
  });

  return targetBatch.id;
};

/**
 * Is this serial sitting in any stock batch right now?
 * Used to skip a serial that was already returned by hand.
 */
export const isSerialInStock = async (tx, serialNumber) => {
  const batch = await tx.storePurchaseOrderItem.findFirst({
    where: { serialNumbers: { has: serialNumber } }
  });
  return Boolean(batch);
};
