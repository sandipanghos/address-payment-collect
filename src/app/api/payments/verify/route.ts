import { NextResponse } from 'next/server';
import { z } from 'zod';
import { getOrderByRazorpayOrderId, updateOrderStatus } from '@/lib/orders';
import { MissingSecretError, tryVerify, verifyCheckoutSignature } from '@/lib/razorpay';

export const runtime = 'nodejs';

const verifySchema = z.object({
  razorpay_order_id: z.string().min(1),
  razorpay_payment_id: z.string().min(1),
  razorpay_signature: z.string().min(1),
});

/**
 * Confirms the browser's success callback so the shopper can be shown a
 * result immediately.
 *
 * This endpoint deliberately does NOT fulfil the order. The browser is an
 * unreliable narrator: the tab can close, the network can drop, and the
 * callback simply never fires even though the money moved. Fulfilment happens
 * in the webhook, which Razorpay retries. Treat this as a UX affordance whose
 * signature check keeps a forged success off the confirmation screen.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }

  const parsed = verifySchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: 'Missing payment fields' }, { status: 400 });
  }

  const {
    razorpay_order_id: razorpayOrderId,
    razorpay_payment_id: razorpayPaymentId,
    razorpay_signature: razorpaySignature,
  } = parsed.data;

  let valid = false;
  try {
    valid = tryVerify(() =>
      verifyCheckoutSignature({ razorpayOrderId, razorpayPaymentId, razorpaySignature }),
    );
  } catch (err) {
    if (err instanceof MissingSecretError) {
      console.error('[verify] RAZORPAY_KEY_SECRET is not configured');
      return NextResponse.json({ error: 'Payments not configured' }, { status: 500 });
    }
    throw err;
  }

  if (!valid) {
    console.warn('[verify] signature mismatch', { razorpayOrderId, razorpayPaymentId });
    return NextResponse.json({ error: 'Payment verification failed' }, { status: 400 });
  }

  const order = getOrderByRazorpayOrderId(razorpayOrderId);
  if (!order) {
    return NextResponse.json({ error: 'Unknown order' }, { status: 404 });
  }

  // 'authorized', not 'paid' — the webhook promotes it once capture confirms.
  updateOrderStatus(order.id, 'authorized', { razorpayPaymentId });

  return NextResponse.json({
    ok: true,
    orderId: order.id,
    status: 'authorized',
  });
}
