import { randomUUID } from 'node:crypto';
import type { Paise } from './money';
import type { PricedCart } from './catalog';
import type { ShippingAddress } from './validation';

/**
 * Order state.
 *
 *   created      — we have an address and a Razorpay order; nothing is paid
 *   authorized   — Razorpay holds the funds, capture pending
 *   paid         — captured. The only state fulfilment may act on
 *   failed       — the customer's payment did not go through
 *   cod_pending  — cash on delivery, no gateway involved
 *   refunded     — money returned
 */
export type OrderStatus =
  | 'created'
  | 'authorized'
  | 'paid'
  | 'failed'
  | 'cod_pending'
  | 'refunded';

export interface Order {
  id: string;
  razorpayOrderId: string | null;
  razorpayPaymentId: string | null;
  status: OrderStatus;
  amountPaise: Paise;
  cart: PricedCart;
  /**
   * A snapshot, not a reference. Customers edit their saved addresses; the
   * address a parcel was shipped to must never change retroactively.
   */
  address: ShippingAddress;
  paymentMode: 'online' | 'cod';
  paymentMethod: string | null;
  fulfilled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * In-memory store so the example runs with no database.
 *
 * It does not survive a restart and does not work across more than one
 * instance. Replace every function below with your database before taking real
 * payments — the call sites are written to need no other change.
 */
const orders = new Map<string, Order>();
const byRazorpayOrderId = new Map<string, string>();

/** Webhook delivery is at-least-once, so processed event ids are remembered. */
const processedEvents = new Set<string>();

export function createOrder(input: {
  cart: PricedCart;
  address: ShippingAddress;
  paymentMode: 'online' | 'cod';
}): Order {
  const now = new Date().toISOString();
  const order: Order = {
    id: `ord_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
    razorpayOrderId: null,
    razorpayPaymentId: null,
    status: input.paymentMode === 'cod' ? 'cod_pending' : 'created',
    amountPaise: input.cart.totalPaise,
    cart: input.cart,
    address: input.address,
    paymentMode: input.paymentMode,
    paymentMethod: null,
    fulfilled: false,
    createdAt: now,
    updatedAt: now,
  };
  orders.set(order.id, order);
  return order;
}

export function getOrder(id: string): Order | undefined {
  return orders.get(id);
}

export function getOrderByRazorpayOrderId(rzpOrderId: string): Order | undefined {
  const localId = byRazorpayOrderId.get(rzpOrderId);
  return localId ? orders.get(localId) : undefined;
}

export function attachRazorpayOrder(orderId: string, rzpOrderId: string): void {
  const order = orders.get(orderId);
  if (!order) return;
  order.razorpayOrderId = rzpOrderId;
  order.updatedAt = new Date().toISOString();
  byRazorpayOrderId.set(rzpOrderId, orderId);
}

/**
 * Status transitions are monotonic: once an order is paid, a late-arriving
 * `payment.failed` for an earlier attempt must not knock it back. Razorpay
 * explicitly warns that webhook events can arrive out of order.
 */
const RANK: Record<OrderStatus, number> = {
  created: 0,
  failed: 1,
  cod_pending: 1,
  authorized: 2,
  paid: 3,
  refunded: 4,
};

export function updateOrderStatus(
  orderId: string,
  status: OrderStatus,
  patch: Partial<Pick<Order, 'razorpayPaymentId' | 'paymentMethod'>> = {},
): Order | undefined {
  const order = orders.get(orderId);
  if (!order) return undefined;

  if (RANK[status] > RANK[order.status]) order.status = status;
  if (patch.razorpayPaymentId) order.razorpayPaymentId = patch.razorpayPaymentId;
  if (patch.paymentMethod) order.paymentMethod = patch.paymentMethod;
  order.updatedAt = new Date().toISOString();
  return order;
}

/** Returns true the first time an event id is seen, false on every replay. */
export function markEventProcessed(eventId: string): boolean {
  if (processedEvents.has(eventId)) return false;
  processedEvents.add(eventId);
  return true;
}

/**
 * The fulfilment seam. Guarded so that duplicate webhooks — which will happen —
 * cannot ship a parcel twice.
 */
export function fulfilOnce(orderId: string, run: (order: Order) => void): void {
  const order = orders.get(orderId);
  if (!order || order.fulfilled) return;
  if (order.status !== 'paid' && order.status !== 'cod_pending') return;
  order.fulfilled = true;
  order.updatedAt = new Date().toISOString();
  run(order);
}
