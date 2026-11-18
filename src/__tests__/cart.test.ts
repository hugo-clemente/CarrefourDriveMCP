import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  summarizeCart,
  summarizeProductList,
  extractErrors,
  extractOrderItems,
  orderHeader,
} from '../carrefour/summarize.js';
import { setQuantity, addQuantity, removeUnavailable } from '../carrefour/cart.service.js';
import { httpService, type HttpResult } from '../services/http.service.js';
import { sessionService } from '../services/session.service.js';
import type { BuiltRequest } from '../spec/types.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string) =>
  JSON.parse(readFileSync(join(here, '..', '..', 'test', 'fixtures', name), 'utf8'));

// --- helpers -----------------------------------------------------------------

const SERVICE = '0261-150-6';

function entry(ean: string, counter: number, opts: { price?: number; available?: boolean; stockOff?: boolean; uri?: string; title?: string } = {}) {
  const price = opts.price ?? 1;
  return {
    counter,
    totalItemPrice: Math.round(price * counter * 100) / 100,
    isStockOff: !!opts.stockOff,
    available: opts.available !== false,
    product: {
      type: 'product',
      attributes: {
        ean,
        title: opts.title ?? `Produit ${ean}`,
        offerServiceId: SERVICE,
        uri: opts.uri ?? `rayon/${ean}`,
        offers: {
          [ean]: {
            [SERVICE]: {
              attributes: {
                availability: { purchasable: opts.available !== false, stopped: false, suspended: false },
                price: { price },
              },
            },
          },
        },
      },
    },
  };
}

function cartOf(entries: unknown[], extra: Record<string, unknown> = {}) {
  return {
    cart: { type: 'drive_clcv', facilityServiceId: SERVICE, storeRef: '6', items: [{ category: 'X', products: entries }], ...extra },
    meta: { errors: [] },
  };
}

// --- summarizer --------------------------------------------------------------

test('summarizeCart keeps every line of a real cart payload, compactly', () => {
  const s = summarizeCart(fixture('cart-feta.json'));
  assert.equal(s.lines.length, 1);
  assert.deepEqual(
    { ...s.lines[0] },
    {
      ean: '3560070149278',
      title: 'Fromage feta CARREFOUR EXTRA',
      brand: 'CARREFOUR EXTRA',
      format: 'la barquette de 200g',
      quantity: 2,
      unitPrice: 2.45,
      lineTotal: 4.9,
      available: true,
      basketServiceId: '0261-150-6',
      subBasketType: 'drive_clcv',
      shelf: 'cremerie/fromage-cuisiner/fromages-mediterraneens/feta',
      promotions: ['-15% Mardi PASS'],
    }
  );
  assert.equal(s.totals.totalAmount, 4.9);
  assert.equal(s.counts.units, 2);
  assert.equal(s.store.basketServiceId, '0261-150-6');
});

test('summarizeCart does not lose lines on a large cart', () => {
  const entries = Array.from({ length: 40 }, (_, i) => entry(String(1000 + i), 1));
  const s = summarizeCart(cartOf(entries));
  assert.equal(s.lines.length, 40);
  // ~6 KB per raw line used to blow the 60 000-char limit after a handful of products.
  assert.ok(JSON.stringify(s, null, 1).length < 60000);
});

test('summarizeCart flags unavailable lines and duplicates', () => {
  const s = summarizeCart(
    cartOf(
      [
        entry('1', 1, { uri: 'cremerie/feta', title: 'Feta A' }),
        entry('2', 1, { uri: 'cremerie/feta', title: 'Feta B' }),
        entry('3', 2, { stockOff: true }),
        entry('4', 1, { available: false }),
      ],
      { nbUnavailable: 3 }
    )
  );
  assert.deepEqual(
    s.unavailable.map((u) => [u.ean, u.unavailableReason]),
    [
      ['3', 'rupture de stock dans ce magasin'],
      ['4', 'non disponible à la vente dans ce magasin'],
    ]
  );
  assert.deepEqual(s.duplicates, [{ kind: 'same_shelf', shelf: 'cremerie/feta', eans: ['1', '2'], titles: ['Feta A', 'Feta B'] }]);
  assert.match(s.warnings[0], /reports 3 unavailable/);
});

test('summarizeCart reads marketplace sub-baskets too', () => {
  const data = { ...cartOf([entry('1', 1)]), marketplace: { subBaskets: { seller: { attributes: { items: [{ products: [entry('9', 3)] }] } } } } };
  const s = summarizeCart(data);
  assert.deepEqual(s.lines.map((l) => [l.ean, l.subBasketType]), [['1', 'drive_clcv'], ['9', 'marketplace']]);
});

test('extractErrors maps the known basket error types', () => {
  assert.deepEqual(extractErrors({ errors: { a: { type: 'UNAVAILABLE_OFFER_NOT_ADDED' } } }), [
    'product unavailable in this store: it was not added',
  ]);
  assert.deepEqual(extractErrors({ meta: { errors: [{ code: 'checkout.error.generic', detail: 'Logic exception' }] } }), [
    'checkout.error.generic: Logic exception',
  ]);
});

test('summarizeProductList compacts a search page and keeps availability', () => {
  const feta = fixture('cart-feta.json').cart.items[0].products[0].product;
  const out = summarizeProductList({ data: [feta], meta: { totalCount: 1 }, links: {} })!;
  assert.deepEqual(out.products[0], {
    ean: '3560070149278',
    title: 'Fromage feta CARREFOUR EXTRA',
    brand: 'CARREFOUR EXTRA',
    format: 'la barquette de 200g',
    price: 2.45,
    perUnit: '12.25 € / KG',
    available: true,
    basketServiceId: '0261-150-6',
    promotions: ['-15% Mardi PASS'],
    nutriscore: 'D',
  });
  assert.equal(out.paging.totalCount, 1);
  assert.equal(summarizeProductList({ foo: 1 }), null);
});

test('extractOrderItems finds product lines whatever the nesting', () => {
  const order = {
    data: {
      attributes: { orderNumber: 'C123', status: 'DELIVERED', totalAmount: 12.5 },
      items: [{ category: 'X', products: [{ counter: 2, totalItemPrice: 4.9, product: { attributes: { ean: '111', title: 'Feta' } } }] }],
    },
  };
  assert.deepEqual(extractOrderItems(order), [{ ean: '111', title: 'Feta', quantity: 2, totalPrice: 4.9 }]);
  assert.deepEqual(orderHeader(order), { orderNumber: 'C123', status: 'DELIVERED', totalAmount: 12.5 });
});

// --- cart operations against a fake Carrefour --------------------------------

/**
 * Mimics what the live API was observed doing on 2026-11-18:
 * - PATCH /api/cart sets the absolute quantity, but counter 0 ADDS one unit;
 * - changing an existing line answers 400 "Logic exception";
 * - PATCH /api/cart/items removes the line;
 * - EANs listed in `unavailable` land in the cart as unavailable lines.
 */
class FakeCarrefour {
  lines = new Map<string, number>();
  unavailable = new Set<string>();
  calls: string[] = [];

  cart() {
    return cartOf([...this.lines].map(([ean, n]) => entry(ean, n, { available: !this.unavailable.has(ean) })));
  }

  handle(req: BuiltRequest): HttpResult {
    const url = new URL(req.url);
    const body = req.body ? JSON.parse(req.body as string) : {};
    const ok = (data: unknown): HttpResult => ({ status: 200, statusText: 'OK', ok: true, url: req.url, contentType: 'application/json', data });
    this.calls.push(`${req.method} ${url.pathname}${req.method === 'PATCH' && url.pathname === '/api/cart' ? `:${body.items[0].counter}` : ''}`);

    if (req.method === 'GET' && url.pathname === '/api/cart') return ok(this.cart());
    if (req.method === 'PATCH' && url.pathname === '/api/cart/items') {
      this.lines.delete(body.ean);
      return ok(this.cart());
    }
    if (req.method === 'PATCH' && url.pathname === '/api/cart') {
      const { ean, counter } = body.items[0];
      if (this.lines.has(ean)) {
        return { status: 400, statusText: 'Bad Request', ok: false, url: req.url, contentType: 'application/json', data: { meta: { errors: [{ code: 'checkout.error.generic', detail: 'Logic exception' }] } } };
      }
      this.lines.set(ean, counter === 0 ? 1 : counter);
      return ok(this.cart());
    }
    throw new Error(`unexpected ${req.method} ${req.url}`);
  }
}

let fake: FakeCarrefour;
beforeEach(() => {
  fake = new FakeCarrefour();
  (httpService as any).send = async (req: BuiltRequest) => fake.handle(req);
  (sessionService as any).hasSession = () => true;
});

test('quantity 0 removes the line through /api/cart/items, never PATCH counter 0', async () => {
  fake.lines.set('feta', 2);
  const r = await setQuantity('feta', 0);
  assert.equal(r.status, 'removed');
  assert.equal(fake.lines.has('feta'), false);
  assert.ok(!fake.calls.includes('PATCH /api/cart:0'));
});

test('removing a product that is not in the cart does nothing', async () => {
  const r = await setQuantity('feta', 0);
  assert.equal(r.status, 'not_in_cart');
  assert.deepEqual(fake.calls, ['GET /api/cart']);
});

test('changing an existing quantity falls back to remove + add when refused', async () => {
  fake.lines.set('lait', 3);
  const r = await setQuantity('lait', 1);
  assert.equal(r.status, 'updated');
  assert.equal(fake.lines.get('lait'), 1);
  assert.equal(r.previousQuantity, 3);
});

test('add_item_to_cart adds on top of the current quantity', async () => {
  fake.lines.set('oeufs', 1);
  const r = await addQuantity('oeufs', 2);
  assert.equal(r.status, 'updated');
  assert.equal(fake.lines.get('oeufs'), 3);
});

test('an unavailable product is reported and not left behind in the cart', async () => {
  fake.unavailable.add('burrata');
  const r = await addQuantity('burrata', 1);
  assert.equal(r.status, 'unavailable_removed');
  assert.equal(fake.lines.has('burrata'), false);
  assert.match(r.message, /unavailable/);
});

test('keepIfUnavailable leaves the line and says so', async () => {
  fake.unavailable.add('burrata');
  const r = await addQuantity('burrata', 1, { removeIfUnavailable: false });
  assert.equal(r.status, 'unavailable_kept');
  assert.equal(fake.lines.get('burrata'), 1);
});

test('removeUnavailable clears only the unavailable lines', async () => {
  fake.lines.set('a', 1);
  fake.lines.set('b', 2);
  fake.lines.set('c', 1);
  fake.unavailable.add('b');
  fake.unavailable.add('c');
  const r = await removeUnavailable();
  assert.deepEqual(r.removed.map((x) => x.ean).sort(), ['b', 'c']);
  assert.deepEqual([...fake.lines.keys()], ['a']);
  assert.equal(r.failed.length, 0);
});
