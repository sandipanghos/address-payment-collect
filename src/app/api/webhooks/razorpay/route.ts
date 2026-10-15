import { NextResponse } from 'next/server';
import {
  fulfilOnce,
  getOrderByRazorpayOrderId,
  markEventProcessed,
  updateOrderStatus,
} from '@/lib/orders';
import { MissingSecretError, tryVerify, verifyWebhookSignature } from '@/lib/razorpay';

export const runtime = 'nodejs';
/** Never cache or statically evaluate a webhook endpoint. */
export const dynamic = 'force-dynamic';

interface RazorpayWebhookPayload {
  event: string;
  payload?: {
    payment?: {
      entity?: {
        id?: string;
        order_id?: string;
        method?: string;
        error_description?: string;
      };
    };
    order?: { entity?: { id?: string } };
    refund?: { entity?: { id?: string } };
  };
}

/**
 * The source of truth for payment state.
 *
 * Razorpay delivers at-least-once and explicitly warns that events can arrive
 * out of order, so this handler is written to be safe under replay and
 * reordering: every event id is deduplicated, status transitions are
 * monotonic, and fulfilment is guarded by a one-shot flag.
 */
export async function POST(req: Request) {
  // The raw bytes, exactly as sent. Parsing first and re-serialising would
  // change key order and whitespace, and the HMAC would never match.
  const rawBody = await req.text();
  const signature = req.headers.get('x-razorpay-signature');

  let signatureValid = false;
  try {
    signatureValid =
      Boolean(signature) && tryVerify(() => verifyWebhookSignature(rawBody, signature!));
  } catch (err) {
    if (err instanceof MissingSecretError) {
      // Our fault, not the caller's. 500 is correct here and the retry is
      // wanted — it buys time to set the secret without losing the event.
      console.error('[webhook] RAZORPAY_WEBHOOK_SECRET is not configured');
      return NextResponse.json({ error: 'Webhook not configured' }, { status: 500 });
    }
    throw err;
  }

  if (!signatureValid) {
    // A forged or corrupted payload. 400 is deliberate: retrying will never
    // make it valid, and a 5xx would have Razorpay redeliver it indefinitely.
    console.warn('[webhook] invalid signature — rejected');
    return NextResponse.json({ error: 'Invalid signature' }, { status: 400 });
  }

  let payload: RazorpayWebhookPayload;
  try {
    payload = JSON.parse(rawBody) as RazorpayWebhookPayload;
  } catch {
    return NextResponse.json({ error: 'Malformed payload' }, { status: 400 });
  }

  // Razorpay's delivery id. Falling back to a composite key keeps dedupe
  // working even if the header is absent.
  const eventId =
    req.headers.get('x-razorpay-event-id') ??
    `${payload.event}:${payload.payload?.payment?.entity?.id ?? ''}`;

  if (!markEventProcessed(eventId)) {
    // Already handled. Acknowledge so Razorpay stops retrying.
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const payment = payload.payload?.payment?.entity;
  const razorpayOrderId = payment?.order_id ?? payload.payload?.order?.entity?.id;
  const order = razorpayOrderId ? getOrderByRazorpayOrderId(razorpayOrderId) : undefined;

  if (!order) {
    // Unknown order: acknowledge anyway. Returning an error would make
    // Razorpay retry an event we can never satisfy.
    console.warn('[webhook] no local order for', razorpayOrderId, payload.event);
    return NextResponse.json({ ok: true, unmatched: true });
  }

  switch (payload.event) {
    case 'payment.authorized':
      updateOrderStatus(order.id, 'authorized', {
        razorpayPaymentId: payment?.id,
        paymentMethod: payment?.method,
      });
      break;

    case 'payment.captured':
    case 'order.paid':
      updateOrderStatus(order.id, 'paid', {
        razorpayPaymentId: payment?.id,
        paymentMethod: payment?.method,
      });
      fulfilOnce(order.id, (paid) => {
        // Your side effects go here: reserve stock, book the courier pickup,
        // send the confirmation. Keep them idempotent regardless — this guard
        // protects against duplicate webhooks, not against your own retries.
        console.info('[fulfil]', paid.id, paid.amountPaise, paid.address.pincode);
      });
      break;

    case 'payment.failed':
      updateOrderStatus(order.id, 'failed', { razorpayPaymentId: payment?.id });
      console.info('[webhook] payment failed', order.id, payment?.error_description);
      break;

    case 'refund.processed':
      updateOrderStatus(order.id, 'refunded');
      break;

    default:
      // Unsubscribed or new event types are acknowledged and ignored.
      break;
  }

  // Acknowledge quickly. Anything slow (email, courier booking) belongs on a
  // queue — Razorpay times these out and retries, which produces duplicates.
  return NextResponse.json({ ok: true });
}
