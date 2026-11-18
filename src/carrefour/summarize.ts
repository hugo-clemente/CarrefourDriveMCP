/**
 * Pure functions turning carrefour.fr JSON into compact, agent-friendly data.
 *
 * The raw payloads are huge (a single cart line weighs ~6 KB: images, reviews,
 * every promotion, legal contacts…). Rendered as-is, a cart of a dozen products
 * blows past the response limit and gets truncated after a handful of lines, so
 * the agent only ever sees the first products and the totals. These helpers keep
 * what matters for shopping: what, how many, how much, and is it available.
 */

type Json = Record<string, any>;

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);
const round2 = (n: unknown): number | null => (typeof n === 'number' ? Math.round(n * 100) / 100 : null);

// --- Offers & availability ---------------------------------------------------

export interface Availability {
  available: boolean;
  /** Why the product cannot be bought here, in French, when it cannot. */
  reason?: string;
}

/** Pick the offer that applies to this product (the one of its offerServiceId). */
export function pickOffer(attrs: Json | undefined, serviceId?: string): Json | undefined {
  const byEan = attrs?.offers?.[attrs?.ean];
  if (!isObj(byEan)) return undefined;
  const id = serviceId ?? attrs?.offerServiceId;
  return (id && byEan[id]) || (Object.values(byEan)[0] as Json | undefined);
}

/** Availability of an offer, as carrefour.fr shows it (stopped / suspended / not purchasable). */
export function offerAvailability(offer: Json | undefined): Availability {
  const a = offer?.attributes?.availability;
  if (!isObj(a)) return { available: false, reason: "pas d'offre dans ce magasin" };
  if (a.stopped) return { available: false, reason: 'produit arrêté' };
  if (a.suspended) return { available: false, reason: a.suspensionReason ? `suspendu (${a.suspensionReason})` : 'suspendu' };
  if (a.purchasable === false) return { available: false, reason: 'non disponible à la vente dans ce magasin' };
  return { available: true };
}

function promoLabels(offer: Json | undefined): string[] | undefined {
  const promos = offer?.attributes?.promotions;
  if (!Array.isArray(promos)) return undefined;
  const labels = promos.map((p: Json) => p?.label).filter((l: unknown): l is string => typeof l === 'string' && !!l);
  return labels.length ? labels : undefined;
}

// --- Cart ----------------------------------------------------------------------

export interface CartLine {
  ean: string;
  title: string;
  brand?: string;
  format?: string;
  quantity: number;
  unitPrice: number | null;
  lineTotal: number | null;
  available: boolean;
  unavailableReason?: string;
  lowStock?: boolean;
  /** Service the line belongs to: pass it back when changing this line. */
  basketServiceId?: string;
  subBasketType: string;
  /** Carrefour's shelf path, used to spot similar products. */
  shelf?: string;
  promotions?: string[];
}

export interface DuplicateGroup {
  kind: 'same_product' | 'same_shelf';
  shelf?: string;
  eans: string[];
  titles: string[];
}

export interface CartSummary {
  store: { storeRef?: string; basketServiceId?: string; pickupMode?: string };
  slot?: { booked: boolean; begin?: string; end?: string };
  counts: { lines: number; units: number; unavailableLines: number; reportedUnavailable?: number };
  totals: {
    totalAmount: number | null;
    productsPrice: number | null;
    savings: number | null;
    fees: number | null;
    currency?: string;
  };
  lines: CartLine[];
  unavailable: Array<Pick<CartLine, 'ean' | 'title' | 'quantity' | 'unavailableReason'>>;
  duplicates: DuplicateGroup[];
  warnings: string[];
}

/** Turn one `items[].products[]` entry into a CartLine. */
export function toCartLine(entry: Json, subBasketType: string, fallbackServiceId?: string): CartLine | null {
  const attrs: Json | undefined = entry?.product?.attributes;
  const ean: string | undefined = attrs?.ean ?? entry?.ean;
  if (!ean) return null;
  const serviceId: string | undefined = attrs?.offerServiceId ?? fallbackServiceId;
  const offer = pickOffer(attrs, serviceId);
  const offerAvail = offerAvailability(offer);

  let available = true;
  let reason: string | undefined;
  if (entry.isStockOff) {
    available = false;
    reason = 'rupture de stock dans ce magasin';
  } else if (entry.available === false) {
    available = false;
    reason = offerAvail.reason ?? 'indisponible dans ce magasin';
  } else if (offer && !offerAvail.available) {
    available = false;
    reason = offerAvail.reason;
  }

  const line: CartLine = {
    ean,
    title: attrs?.title ?? attrs?.shortTitle ?? ean,
    brand: attrs?.brand ?? undefined,
    format: attrs?.packaging ?? attrs?.format ?? undefined,
    quantity: typeof entry.counter === 'number' ? entry.counter : Number(entry.counter ?? entry.quantity ?? 0),
    unitPrice: round2(offer?.attributes?.price?.price),
    lineTotal: round2(entry.totalItemPrice),
    available,
    basketServiceId: serviceId,
    subBasketType,
    shelf: attrs?.uri ?? undefined,
  };
  if (reason) line.unavailableReason = reason;
  if (offer?.attributes?.availability?.hasLowQuantity) line.lowStock = true;
  const promos = promoLabels(offer);
  if (promos) line.promotions = promos;
  return line;
}

/** Lines of one cart-like object (`cart`, or one entry of preorder / additionalOrders…). */
function linesOf(cartLike: Json | undefined, subBasketType: string): CartLine[] {
  const groups = cartLike?.items;
  if (!Array.isArray(groups)) return [];
  const fallback: string | undefined = cartLike?.facilityServiceId;
  const out: CartLine[] = [];
  for (const group of groups) {
    const products = Array.isArray(group?.products) ? group.products : isObj(group?.product) ? [group] : [];
    for (const entry of products) {
      const line = toCartLine(entry, subBasketType, fallback);
      if (line) out.push(line);
    }
  }
  return out;
}

/** Every line of every sub-basket (drive, marketplace, pre-order…). */
export function extractCartLines(data: Json): CartLine[] {
  const lines = linesOf(data?.cart, data?.cart?.type || 'drive_clcv');

  const subBaskets = data?.marketplace?.subBaskets;
  const marketplace = Array.isArray(subBaskets) ? subBaskets : isObj(subBaskets) ? Object.values(subBaskets) : [];
  for (const sb of marketplace) lines.push(...linesOf(sb?.attributes ?? sb, 'marketplace'));

  const others: Array<[string, string]> = [
    ['nonFoodDeliveryCart', 'home_delivery_nal'],
    ['preorder', 'pre_order'],
    ['additionalOrders', 'additional_order'],
  ];
  for (const [key, type] of others) {
    const v = data?.[key];
    for (const c of Array.isArray(v) ? v : isObj(v) ? [v] : []) lines.push(...linesOf(c, c?.type || type));
  }
  return lines;
}

/** Same EAN on several lines, or several products from the same shelf. */
export function findDuplicates(lines: CartLine[]): DuplicateGroup[] {
  const out: DuplicateGroup[] = [];

  const byEan = new Map<string, CartLine[]>();
  for (const l of lines) byEan.set(l.ean, [...(byEan.get(l.ean) ?? []), l]);
  for (const [ean, ls] of byEan) {
    if (ls.length > 1) out.push({ kind: 'same_product', eans: [ean], titles: ls.map((l) => l.title) });
  }

  const byShelf = new Map<string, CartLine[]>();
  for (const l of lines) if (l.shelf) byShelf.set(l.shelf, [...(byShelf.get(l.shelf) ?? []), l]);
  for (const [shelf, ls] of byShelf) {
    const eans = [...new Set(ls.map((l) => l.ean))];
    if (eans.length > 1) {
      out.push({ kind: 'same_shelf', shelf, eans, titles: eans.map((e) => ls.find((l) => l.ean === e)!.title) });
    }
  }
  return out;
}

export function summarizeCart(data: Json): CartSummary {
  const cart: Json = data?.cart ?? {};
  const lines = extractCartLines(data);
  const unavailable = lines.filter((l) => !l.available);
  const warnings: string[] = [];

  const reported = typeof cart.nbUnavailable === 'number' ? cart.nbUnavailable : undefined;
  if (reported !== undefined && reported > unavailable.length) {
    warnings.push(
      `Carrefour reports ${reported} unavailable item(s) but only ${unavailable.length} could be identified; ` +
        'call get_cart with raw=true to inspect the full payload.'
    );
  }
  for (const err of extractErrors(data)) warnings.push(err);

  const slot = cart.slot;
  return {
    store: { storeRef: cart.storeRef, basketServiceId: cart.facilityServiceId, pickupMode: cart.pickupMode },
    slot: isObj(slot)
      ? { booked: !!(slot.isBooked ?? cart.isSlotBooked), begin: slot.date?.begin ?? undefined, end: slot.date?.end ?? undefined }
      : undefined,
    counts: {
      lines: lines.length,
      units: lines.reduce((n, l) => n + (Number.isFinite(l.quantity) ? l.quantity : 0), 0),
      unavailableLines: unavailable.length,
      reportedUnavailable: reported,
    },
    totals: {
      totalAmount: round2(cart.totalAmount),
      productsPrice: round2(cart.totalProductsPrice),
      savings: round2(cart.totalSavings),
      fees: round2(cart.totalFees),
      currency: cart.currency,
    },
    lines,
    unavailable: unavailable.map(({ ean, title, quantity, unavailableReason }) => ({ ean, title, quantity, unavailableReason })),
    duplicates: findDuplicates(lines),
    warnings,
  };
}

export function findLine(data: Json, ean: string): CartLine | undefined {
  return extractCartLines(data).find((l) => l.ean === ean);
}

// --- Errors --------------------------------------------------------------------

const ERROR_MESSAGES: Record<string, string> = {
  UNAVAILABLE_OFFER_NOT_ADDED: "product unavailable in this store: it was not added",
  MAX_NUMBER_OF_OFFERS_REACHED: 'maximum number of products in the cart reached',
  SHIPPING_TYPE_NOT_COMPATIBLE: 'product not compatible with this delivery mode',
  CATEGORY_LIMIT_EXCEEDED: 'quantity limit reached for this category',
};

/** Business errors from a cart response (`errors` map or `meta.errors` list). */
export function extractErrors(data: Json): string[] {
  const out: string[] = [];
  const top = data?.errors;
  const topList = Array.isArray(top) ? top : isObj(top) ? Object.values(top) : [];
  const metaList = Array.isArray(data?.meta?.errors) ? data.meta.errors : [];
  for (const e of [...topList, ...metaList]) {
    if (!isObj(e)) continue;
    const type: string | undefined = e.type ?? e.code;
    const known = type ? ERROR_MESSAGES[type] : undefined;
    const extra = type === 'CATEGORY_LIMIT_EXCEEDED' && e.attributes?.categoryLimitName ? ` (${e.attributes.categoryLimitName})` : '';
    out.push(known ? `${known}${extra}` : [type, e.detail ?? e.title].filter(Boolean).join(': ') || JSON.stringify(e));
  }
  return out;
}

// --- Product lists (search, frequent purchases…) ---------------------------------

export interface ProductSummary {
  ean: string;
  title: string;
  brand?: string;
  format?: string;
  price: number | null;
  perUnit?: string;
  available: boolean;
  unavailableReason?: string;
  basketServiceId?: string;
  promotions?: string[];
  nutriscore?: string;
}

export function summarizeProduct(p: Json): ProductSummary | null {
  const attrs: Json | undefined = p?.attributes;
  if (!attrs?.ean) return null;
  const offer = pickOffer(attrs);
  const avail = offerAvailability(offer);
  const out: ProductSummary = {
    ean: attrs.ean,
    title: attrs.title ?? attrs.shortTitle ?? attrs.ean,
    brand: attrs.brand ?? undefined,
    format: attrs.packaging ?? attrs.format ?? undefined,
    price: round2(offer?.attributes?.price?.price),
    perUnit: offer?.attributes?.price?.perUnitLabel ?? undefined,
    available: avail.available,
    basketServiceId: offer?.attributes?.offerServiceId ?? attrs.offerServiceId ?? undefined,
  };
  if (avail.reason) out.unavailableReason = avail.reason;
  const promos = promoLabels(offer);
  if (promos) out.promotions = promos;
  if (attrs.nutriscore?.value) out.nutriscore = attrs.nutriscore.value;
  return out;
}

/**
 * Compact a JSON:API product listing (`{data: [{type: 'product', …}], meta, links}`).
 * Returns null when the payload is not such a listing, so the caller can fall
 * back to the raw response.
 */
export function summarizeProductList(data: Json): Json | null {
  const items = Array.isArray(data?.data) ? data.data : null;
  if (!items) return null;
  const products = items
    .filter((i: Json) => i?.type === 'product' || i?.attributes?.ean)
    .map(summarizeProduct)
    .filter((p: ProductSummary | null): p is ProductSummary => p !== null);
  if (!products.length && items.length) return null;

  const meta = isObj(data.meta) ? data.meta : {};
  const paging: Json = {};
  for (const k of ['total', 'totalCount', 'count', 'itemsPerPage', 'currentPage', 'page', 'totalPage', 'totalPages']) {
    if (typeof meta[k] === 'number') paging[k] = meta[k];
  }
  if (isObj(data.links)) {
    for (const k of ['next', 'prev', 'last']) if (data.links[k]) paging[k] = data.links[k];
  }
  return { products, paging };
}

// --- Orders ------------------------------------------------------------------------

export interface OrderItem {
  ean?: string;
  title?: string;
  quantity?: number;
  unitPrice?: number | null;
  totalPrice?: number | null;
  status?: string;
}

const QTY_KEYS = ['counter', 'quantity', 'qty', 'orderedQuantity', 'deliveredQuantity', 'pickedQuantity', 'nbItems'];
const TOTAL_KEYS = ['totalItemPrice', 'totalPrice', 'total', 'amount', 'totalAmount'];
const TITLE_KEYS = ['title', 'shortTitle', 'label', 'name', 'productName'];

function firstOf(o: Json, keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null && o[k] !== '') return o[k];
  return undefined;
}

/** Recognise one ordered product, whatever the exact shape of the order payload. */
function toOrderItem(o: Json): OrderItem | null {
  const attrs: Json = o.product?.attributes ?? o.attributes ?? {};
  const ean = o.ean ?? o.gtin ?? attrs.ean ?? o.product?.ean;
  if (typeof ean !== 'string' && typeof ean !== 'number') return null;
  const qty = firstOf(o, QTY_KEYS);
  const item: OrderItem = { ean: String(ean) };
  const title = firstOf(attrs, TITLE_KEYS) ?? firstOf(o, TITLE_KEYS);
  if (typeof title === 'string') item.title = title;
  if (qty !== undefined && !isNaN(Number(qty))) item.quantity = Number(qty);
  const offer = pickOffer(attrs);
  const unit = offer?.attributes?.price?.price ?? (typeof o.unitPrice === 'number' ? o.unitPrice : undefined);
  if (unit !== undefined) item.unitPrice = round2(unit);
  const total = firstOf(o, TOTAL_KEYS);
  if (typeof total === 'number') item.totalPrice = round2(total);
  if (typeof o.status === 'string') item.status = o.status;
  return item;
}

/** Walk any JSON and collect the ordered products it contains. */
export function extractOrderItems(data: unknown): OrderItem[] {
  const out: OrderItem[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 12 || node === null || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const n of node) walk(n, depth + 1);
      return;
    }
    const item = toOrderItem(node as Json);
    if (item) {
      out.push(item);
      return; // do not descend into the product itself (offers, variants…)
    }
    for (const v of Object.values(node as Json)) walk(v, depth + 1);
  };
  walk(data, 0);
  return out;
}

/** Top-level scalar fields describing an order (number, dates, status, amounts). */
export function orderHeader(data: unknown): Json {
  const root: Json = isObj(data) ? ((data as Json).data?.attributes ?? (data as Json).data ?? data) : {};
  const out: Json = {};
  const visit = (o: Json, prefix: string, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (Object.keys(out).length >= 40) return;
      if (v === null || v === undefined || v === '') continue;
      if (typeof v !== 'object') {
        if (typeof v === 'string' && v.length > 200) continue;
        out[prefix + k] = v;
      } else if (isObj(v) && depth < 1 && !/items|products|links|categories/i.test(k)) {
        visit(v, `${prefix}${k}.`, depth + 1);
      }
    }
  };
  if (isObj(root)) visit(root, '', 0);
  return out;
}
