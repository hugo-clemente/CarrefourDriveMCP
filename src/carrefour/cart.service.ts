import { callSpec } from '../spec/call.js';
import type { HttpResult } from '../services/http.service.js';
import { extractErrors, findLine, summarizeCart, type CartLine, type CartSummary } from './summarize.js';

/**
 * Cart operations, built on what carrefour.fr itself does (read from its
 * front-end bundle and checked against the live API on 2026-11-18):
 *
 * - `PATCH /api/cart` with `items[].counter` sets the ABSOLUTE quantity of a
 *   line. It is how the site adds products. A counter of 0 is never sent by the
 *   site, and the API answers it by adding one unit — which is why "set the
 *   quantity to 0" used to make the cart more expensive.
 * - `PATCH /api/cart/items` with `{ean, basketServiceId, subBasketType}`
 *   removes the whole line. This is the site's "Supprimer" link. It was exposed
 *   as `add_item_to_cart_by_ean`, a misleading name.
 * - Changing the quantity of a line already in the cart can be refused with a
 *   400 "Logic exception" (seen on guest carts). Removing the line and adding
 *   it back with the wanted quantity always works, so that is the fallback.
 */

type Json = Record<string, any>;

const DEFAULT_SUB_BASKET = 'drive_clcv';
const TRACKING = { pageType: 'basket', pageId: 'basket' };

export class CartApiError extends Error {
  constructor(message: string, public result?: HttpResult) {
    super(message);
  }
}

function describeFailure(result: HttpResult): string {
  const errors = extractErrors(result.data as Json);
  const detail = errors.length ? errors.join('; ') : typeof result.data === 'string' ? result.data.slice(0, 300) : '';
  return `HTTP ${result.status}${detail ? ` — ${detail}` : ''}`;
}

export async function fetchCart(refresh = false): Promise<Json> {
  const res = await callSpec('cart_fetch', refresh ? { refresh: true } : {});
  if (!res.ok || typeof res.data !== 'object' || res.data === null) {
    throw new CartApiError(`Could not read the cart: ${describeFailure(res)}`, res);
  }
  return res.data as Json;
}

interface LineTarget {
  ean: string;
  basketServiceId: string;
  subBasketType: string;
}

function target(cart: Json, ean: string, line?: CartLine, basketServiceId?: string, subBasketType?: string): LineTarget {
  const serviceId = basketServiceId ?? line?.basketServiceId ?? cart?.cart?.facilityServiceId;
  if (!serviceId) {
    throw new CartApiError(
      'No basketServiceId: the cart has no store attached. Pick a Drive store first, or pass basketServiceId ' +
        '(the basketServiceId field returned by search_products).'
    );
  }
  return { ean, basketServiceId: serviceId, subBasketType: subBasketType ?? line?.subBasketType ?? DEFAULT_SUB_BASKET };
}

async function patchQuantity(t: LineTarget, quantity: number): Promise<HttpResult> {
  return callSpec('cart_patch_items', { ...t, counter: quantity, ...TRACKING });
}

async function removeLineRaw(t: LineTarget): Promise<HttpResult> {
  return callSpec('remove_item_from_cart_raw', { ...t, ...TRACKING });
}

export type ChangeStatus =
  | 'updated'
  | 'removed'
  | 'not_in_cart'
  | 'unavailable_not_added'
  | 'unavailable_removed'
  | 'unavailable_kept'
  | 'failed';

export interface ChangeResult {
  status: ChangeStatus;
  ean: string;
  message: string;
  previousQuantity: number;
  requestedQuantity: number;
  line?: CartLine;
  errors?: string[];
  cart: Pick<CartSummary, 'counts' | 'totals' | 'unavailable'>;
}

function shortCart(data: Json): ChangeResult['cart'] {
  const s = summarizeCart(data);
  return { counts: s.counts, totals: s.totals, unavailable: s.unavailable };
}

export interface SetQuantityOptions {
  basketServiceId?: string;
  subBasketType?: string;
  /** Remove a line that ends up unavailable in the store (default true). */
  removeIfUnavailable?: boolean;
}

/**
 * Bring the line for `ean` to exactly `quantity` units (0 removes it), then
 * re-read the cart to report what really happened.
 */
export async function setQuantity(ean: string, quantity: number, opts: SetQuantityOptions = {}): Promise<ChangeResult> {
  if (!Number.isInteger(quantity) || quantity < 0) throw new CartApiError('quantity must be a whole number, 0 or more');
  const removeIfUnavailable = opts.removeIfUnavailable !== false;

  const before = await fetchCart();
  const existing = findLine(before, ean);
  const previousQuantity = existing?.quantity ?? 0;
  const t = target(before, ean, existing, opts.basketServiceId, opts.subBasketType);
  const base = { ean, previousQuantity, requestedQuantity: quantity };

  // --- removal ---
  if (quantity === 0) {
    if (!existing) {
      return { ...base, status: 'not_in_cart', message: 'This product is not in the cart: nothing to remove.', cart: shortCart(before) };
    }
    const res = await removeLineRaw(t);
    if (!res.ok) throw new CartApiError(`Removal refused: ${describeFailure(res)}`, res);
    const after = await fetchCart();
    const still = findLine(after, ean);
    return still
      ? { ...base, status: 'failed', line: still, message: 'Carrefour accepted the removal but the line is still in the cart.', cart: shortCart(after) }
      : { ...base, status: 'removed', message: `Removed "${existing.title}" (${previousQuantity} unit(s)).`, cart: shortCart(after) };
  }

  // --- add / change ---
  let res = await patchQuantity(t, quantity);
  if (!res.ok && existing) {
    // Changing an existing line can be refused: remove it and add it back.
    const removed = await removeLineRaw(t);
    if (!removed.ok) throw new CartApiError(`Quantity change refused (${describeFailure(res)}) and removal failed too: ${describeFailure(removed)}`, removed);
    res = await patchQuantity(t, quantity);
    if (!res.ok) {
      // Put the previous quantity back so the cart is left as we found it.
      await patchQuantity(t, previousQuantity).catch(() => undefined);
      throw new CartApiError(`Quantity change refused: ${describeFailure(res)}`, res);
    }
  } else if (!res.ok) {
    const errors = extractErrors(res.data as Json);
    const after = await fetchCart();
    const line = findLine(after, ean);
    if (!line) {
      return {
        ...base,
        status: errors.some((e) => e.includes('unavailable')) ? 'unavailable_not_added' : 'failed',
        errors,
        message: `Not added: ${describeFailure(res)}`,
        cart: shortCart(after),
      };
    }
  }

  const errors = extractErrors(res.data as Json);
  const after = await fetchCart();
  const line = findLine(after, ean);

  if (!line) {
    const unavailable = errors.some((e) => e.includes('unavailable'));
    return {
      ...base,
      status: unavailable ? 'unavailable_not_added' : 'failed',
      errors,
      message: unavailable
        ? 'This product is unavailable in your Drive store: Carrefour did not add it.'
        : `Carrefour answered ${res.status} but the product is not in the cart.${errors.length ? ` ${errors.join('; ')}` : ''}`,
      cart: shortCart(after),
    };
  }

  if (!line.available) {
    const wasAvailableBefore = existing ? existing.available : false;
    if (removeIfUnavailable && !wasAvailableBefore) {
      const removed = await removeLineRaw(target(after, ean, line));
      const final = removed.ok ? await fetchCart() : after;
      const gone = !findLine(final, ean);
      return {
        ...base,
        status: gone ? 'unavailable_removed' : 'unavailable_kept',
        line,
        errors,
        message: gone
          ? `"${line.title}" is unavailable in your Drive store (${line.unavailableReason ?? 'unavailable'}): ` +
            'Carrefour put it in the cart as unavailable, so it was removed again. Look for an alternative.'
          : `"${line.title}" is unavailable (${line.unavailableReason ?? 'unavailable'}) and could not be removed automatically.`,
        cart: shortCart(final),
      };
    }
    return {
      ...base,
      status: 'unavailable_kept',
      line,
      errors,
      message: `"${line.title}" is in the cart but unavailable in your Drive store (${line.unavailableReason ?? 'unavailable'}).`,
      cart: shortCart(after),
    };
  }

  const ok = line.quantity === quantity;
  return {
    ...base,
    status: ok ? 'updated' : 'failed',
    line,
    errors: errors.length ? errors : undefined,
    message: ok
      ? `"${line.title}": ${previousQuantity} → ${quantity} unit(s).`
      : `Asked for ${quantity} unit(s) of "${line.title}" but the cart holds ${line.quantity}.${errors.length ? ` ${errors.join('; ')}` : ''}`,
    cart: shortCart(after),
  };
}

/** Add `quantity` units on top of what is already in the cart. */
export async function addQuantity(ean: string, quantity: number, opts: SetQuantityOptions = {}): Promise<ChangeResult> {
  if (!Number.isInteger(quantity) || quantity < 1) throw new CartApiError('quantity must be a whole number, 1 or more');
  const current = findLine(await fetchCart(), ean)?.quantity ?? 0;
  return setQuantity(ean, current + quantity, opts);
}

export interface CleanResult {
  removed: Array<Pick<CartLine, 'ean' | 'title' | 'quantity' | 'unavailableReason'>>;
  failed: Array<{ ean: string; title: string; error: string }>;
  cart: ChangeResult['cart'];
}

/** Remove every unavailable line, one by one, through the site's own removal call. */
export async function removeUnavailable(): Promise<CleanResult> {
  const before = await fetchCart();
  const summary = summarizeCart(before);
  const result: CleanResult = { removed: [], failed: [], cart: shortCart(before) };
  const lines = summary.lines.filter((l) => !l.available);
  for (const line of lines) {
    const res = await removeLineRaw(target(before, line.ean, line));
    if (res.ok) {
      result.removed.push({ ean: line.ean, title: line.title, quantity: line.quantity, unavailableReason: line.unavailableReason });
    } else {
      result.failed.push({ ean: line.ean, title: line.title, error: describeFailure(res) });
    }
  }
  if (lines.length) {
    const after = await fetchCart();
    result.cart = shortCart(after);
    for (const r of [...result.removed]) {
      if (findLine(after, r.ean)) {
        result.removed = result.removed.filter((x) => x.ean !== r.ean);
        result.failed.push({ ean: r.ean, title: r.title, error: 'still in the cart after removal' });
      }
    }
  }
  return result;
}
