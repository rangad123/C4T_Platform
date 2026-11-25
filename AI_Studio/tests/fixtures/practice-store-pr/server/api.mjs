// Trimmed from the practice store's server/api.mjs (test-site, a3c2867), with the PR's change in (express 999 → 1299): the route table
// one dispatcher reads. Only what the impact tests need is kept.
import { dollars, fail } from './util.mjs';

const QTY_MSG = 'Quantity must be between 1 and 10.';
const SHIPPING = { standard: 0, express: 1299 };

const str = (title, extra = {}) => ({ type: 'string', title, ...extra });

// ---------- views
function cartOf(ctx) {
  const { carts } = ctx.app.state;
  if (!carts.has(ctx.user.id)) carts.set(ctx.user.id, { items: [], codes: [] });
  return carts.get(ctx.user.id);
}

function cartTotals(ctx, method = 'standard') {
  const cart = cartOf(ctx);
  const items = cart.items.map((it) => ({ id: it.id, qty: it.qty, lineTotal: it.qty * 100 }));
  const subtotal = items.reduce((s, i) => s + i.lineTotal, 0);
  const shipping = items.length ? SHIPPING[method] ?? 0 : 0;
  return { cart, items, subtotal, shipping, total: subtotal + shipping, method };
}

function cartView(ctx, method) {
  const t = cartTotals(ctx, method);
  return { items: t.items, subtotal: dollars(t.subtotal), shipping: { method: t.method, cost: dollars(t.shipping) }, total: dollars(t.total) };
}

// ---------- routes
export const routes = [
  {
    method: 'GET', path: '/api/cart/items', tag: 'cart', summary: 'Your cart with totals', auth: 'user',
    query: { type: 'object', properties: { shipping: str('Shipping choice for the total', { enum: ['standard', 'express'] }) } },
    responses: { 200: 'Cart', 401: 'Error' },
    handler: (ctx) => ({ body: cartView(ctx, ctx.query.shipping) }),
  },
  {
    method: 'POST', path: '/api/cart/items', tag: 'cart', summary: 'Add a product', auth: 'user',
    body: { type: 'object', required: ['productId'], properties: { productId: { type: 'integer', minimum: 1 }, qty: { type: 'integer', minimum: 1, maximum: 10, 'x-message': QTY_MSG } } },
    handler(ctx) {
      const cart = cartOf(ctx);
      cart.items.push({ id: cart.items.length + 1, productId: ctx.body.productId, qty: ctx.body.qty ?? 1 });
      return { status: 201, body: cartView(ctx) };
    },
  },
  {
    method: 'POST', path: '/api/orders', tag: 'orders', summary: 'Place an order from your cart', auth: 'user',
    body: { type: 'object', required: ['shipping'], properties: { shipping: str('Shipping', { enum: ['standard', 'express'] }) } },
    responses: { 201: 'OrderResult', 400: 'Error' },
    handler(ctx) {
      const t = cartTotals(ctx, ctx.body.shipping);
      if (!t.items.length) fail(400, 'Your cart is empty.', { code: 'cart_empty' });
      const o = { id: ctx.app.state.next.order++, userId: ctx.user.id, subtotal: t.subtotal, shipping: { method: t.method, cost: t.shipping }, total: t.total, status: 'pending' };
      ctx.app.state.orders.push(o);
      return { status: 201, body: { order: o } };
    },
  },
  { method: 'GET', path: '/api/orders/:id', tag: 'orders', summary: 'One of your orders', auth: 'user',
    handler(ctx) { const o = ctx.app.state.orders.find((x) => x.id === Number(ctx.params.id)); if (!o) fail(404, 'Order not found.'); return { body: o }; } },
  { method: 'GET', path: '/api/health', tag: 'system', summary: 'Health check', responses: { 200: 'Health' },
    handler: (ctx) => ({ body: { ok: true, bugs: [...ctx.bugs] } }) },
];

for (const r of routes) {
  r.keys = [];
  r.regex = new RegExp('^' + r.path.replace(/:(\w+)/g, (_, k) => { r.keys.push(k); return '([^/]+)'; }) + '$');
}

export function dispatch(ctx, method, path) {
  const r = routes.find((x) => x.method === method && x.regex.test(path));
  return r ? r.handler(ctx) : fail(404, 'Not found.');
}
