import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  addQuantity,
  fetchCart,
  removeUnavailable,
  setQuantity,
  type ChangeResult,
} from '../carrefour/cart.service.js';
import { extractOrderItems, orderHeader, summarizeCart } from '../carrefour/summarize.js';
import { callSpec } from '../spec/call.js';
import { logger } from '../utils/logger.js';

const MAX_RAW_CHARS = parseInt(process.env.CARREFOUR_MAX_RESPONSE_CHARS || '60000', 10);

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
}

function json(data: unknown, isError = false) {
  return text(JSON.stringify(data, null, 1), isError);
}

function raw(data: unknown) {
  const out = typeof data === 'string' ? data : JSON.stringify(data);
  return text(
    out.length <= MAX_RAW_CHARS
      ? out
      : `${out.slice(0, MAX_RAW_CHARS)}\n\n[truncated: ${out.length} chars total — raise CARREFOUR_MAX_RESPONSE_CHARS]`
  );
}

async function guard(name: string, fn: () => Promise<ReturnType<typeof text>>) {
  try {
    return await fn();
  } catch (error) {
    logger.error('Tool failed', { tool: name, error: String(error) });
    return text(`${name} failed: ${(error as Error).message}`, true);
  }
}

function changeReply(result: ChangeResult) {
  const isError = result.status === 'failed' || result.status === 'unavailable_kept';
  return json(result, isError);
}

const ean = z.string().describe('EAN (barcode) of the product, as returned by search_products or get_cart.');
const basketServiceId = z
  .string()
  .optional()
  .describe("Service of the offer (basketServiceId from search_products). Defaults to the cart's Drive store.");
const subBasketType = z
  .string()
  .optional()
  .describe("Sub-basket, default 'drive_clcv' (Drive click & collect).");

export function registerCartTools(server: McpServer): void {
  server.tool(
    'get_cart',
    'Read the whole Carrefour Drive cart as a compact summary: every line with EAN, title, format, quantity, unit ' +
      'price, line total and availability in the store, plus totals, the list of unavailable items and possible ' +
      'duplicates (same product twice, or several products from the same shelf). (requires an authenticated Carrefour session)',
    {
      refresh: z.boolean().optional().describe('Ask Carrefour to resynchronise the cart (prices, stock) before answering.'),
      raw: z.boolean().optional().describe('Return the raw API payload instead of the summary (very large).'),
    },
    async ({ refresh, raw: wantRaw }) =>
      guard('get_cart', async () => {
        const data = await fetchCart(!!refresh);
        return wantRaw ? raw(data) : json(summarizeCart(data));
      })
  );

  server.tool(
    'add_item_to_cart',
    'Add units of a product to the Drive cart, on top of what is already there (quantity 1 by default). Checks the ' +
      'result: if the product turns out to be unavailable in the store, the line Carrefour leaves behind is removed ' +
      'again and the answer says so (status unavailable_removed / unavailable_not_added). (requires an authenticated Carrefour session)',
    {
      ean,
      quantity: z.number().int().min(1).optional().describe('Units to add (default 1).'),
      basketServiceId,
      subBasketType,
      keepIfUnavailable: z.boolean().optional().describe('Leave an unavailable line in the cart instead of removing it.'),
    },
    async (args) =>
      guard('add_item_to_cart', async () =>
        changeReply(
          await addQuantity(args.ean, args.quantity ?? 1, {
            basketServiceId: args.basketServiceId,
            subBasketType: args.subBasketType,
            removeIfUnavailable: !args.keepIfUnavailable,
          })
        )
      )
  );

  server.tool(
    'set_cart_item_quantity',
    'Set the exact quantity of a product in the Drive cart. 0 removes the line (through the same call as the ' +
      '"Supprimer" link on carrefour.fr). Re-reads the cart afterwards and reports the real outcome. (requires an authenticated Carrefour session)',
    {
      ean,
      quantity: z.number().int().min(0).describe('Exact number of units wanted. 0 removes the product.'),
      basketServiceId,
      subBasketType,
      keepIfUnavailable: z.boolean().optional().describe('Leave an unavailable line in the cart instead of removing it.'),
    },
    async (args) =>
      guard('set_cart_item_quantity', async () =>
        changeReply(
          await setQuantity(args.ean, args.quantity, {
            basketServiceId: args.basketServiceId,
            subBasketType: args.subBasketType,
            removeIfUnavailable: !args.keepIfUnavailable,
          })
        )
      )
  );

  server.tool(
    'remove_item_from_cart',
    'Remove a product (the whole line) from the Drive cart, then check it is really gone. (requires an authenticated Carrefour session)',
    { ean, basketServiceId, subBasketType },
    async (args) =>
      guard('remove_item_from_cart', async () =>
        changeReply(await setQuantity(args.ean, 0, { basketServiceId: args.basketServiceId, subBasketType: args.subBasketType }))
      )
  );

  server.tool(
    'remove_unavailable_items_from_cart',
    'Remove every line that is unavailable in the Drive store (out of stock, stopped, failed additions left behind). ' +
      'Returns what was removed and what could not be. (requires an authenticated Carrefour session)',
    {},
    async () => guard('remove_unavailable_items_from_cart', async () => json(await removeUnavailable()))
  );

  server.tool(
    'get_order_details',
    'Detail of one past online (Drive) order, product by product: EAN, title, quantity and price, plus the order ' +
      'header (date, status, amounts) and the items that can no longer be ordered. Take the order number from get_orders ' +
      'or get_last_orders. (requires an authenticated Carrefour session)',
    {
      orderNumber: z.string().describe('Order number, as returned by get_orders.'),
      raw: z.boolean().optional().describe('Return the raw API payloads instead of the summary.'),
    },
    async ({ orderNumber, raw: wantRaw }) =>
      guard('get_order_details', async () => {
        const [detail, reorder] = await Promise.all([
          callSpec('get_online_order', { orderNumber }),
          callSpec('get_order_reorder_items', { orderNumber }),
        ]);
        if (!detail.ok && !reorder.ok) {
          return text(`Carrefour answered HTTP ${detail.status} / ${reorder.status} for order ${orderNumber}.`, true);
        }
        if (wantRaw) return raw({ order: detail.ok ? detail.data : null, reorder: reorder.ok ? reorder.data : null });

        const reorderData = reorder.ok ? (reorder.data as Record<string, any>) : null;
        const fromDetail = detail.ok ? extractOrderItems(detail.data) : [];
        const fromReorder = reorderData ? extractOrderItems(reorderData.categories ?? reorderData) : [];
        const missing = reorderData?.missingItems ? extractOrderItems(reorderData.missingItems) : [];

        // The order detail carries what was bought (quantities, prices); the
        // reorder list fills the gaps (titles) when the detail lacks them.
        const items = fromDetail.length ? fromDetail : fromReorder;
        const titles = new Map(fromReorder.filter((i) => i.title).map((i) => [i.ean, i.title]));
        for (const i of items) if (!i.title && i.ean && titles.has(i.ean)) i.title = titles.get(i.ean);

        const summary = {
          orderNumber,
          header: detail.ok ? orderHeader(detail.data) : undefined,
          itemCount: items.length,
          units: items.reduce((n, i) => n + (i.quantity ?? 0), 0),
          items,
          noLongerAvailable: missing.length ? missing : undefined,
          warnings: [
            ...(!detail.ok ? [`order detail answered HTTP ${detail.status}; items come from the reorder list`] : []),
            ...(!reorder.ok ? [`reorder list answered HTTP ${reorder.status}`] : []),
            ...(!items.length ? ['no product line recognised: call again with raw=true'] : []),
          ],
        };
        return json(summary);
      })
  );
}
