import { NextResponse } from 'next/server';
import { CatalogError, priceCart } from '@/lib/catalog';
import { getServiceability } from '@/lib/pincode';
import { attachRazorpayOrder, createOrder } from '@/lib/orders';
import { createRazorpayOrder } from '@/lib/razorpay';
import { createOrderSchema, fieldErrors } from '@/lib/validation';

export const runtime = 'nodejs';

/**
 * Creates an order and, for online payments, the Razorpay order the browser
 * will pay against.
 *
 * The amount is computed here from the server-side catalogue. The request body
 * carries no price at all, so there is nothing for a tampered client to inflate
 * or discount.
 */
export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Malformed JSON body' }, { status: 400 });
  }

  const parsed = createOrderSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Please check the highlighted fields', fields: fieldErrors(parsed.error) },
      { status: 400 },
    );
  }
  const { lines, address, paymentMode } = parsed.data;

  // Refuse undeliverable addresses before taking any money for them.
  const serviceability = await getServiceability(address.pincode);
  if (!serviceability.serviceable) {
    return NextResponse.json(
      {
        error: serviceability.reason ?? 'We do not deliver to this PIN code yet',
        fields: { pincode: 'Not serviceable' },
      },
      { status: 422 },
    );
  }
  if (paymentMode === 'cod' && !serviceability.codAvailable) {
    return NextResponse.json(
      { error: 'Cash on delivery is not available for this PIN code' },
      { status: 422 },
    );
  }

  let cart;
  try {
    cart = priceCart(lines);
  } catch (err) {
    if (err instanceof CatalogError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    throw err;
  }

  const order = createOrder({ cart, address, paymentMode });

  if (paymentMode === 'cod') {
    return NextResponse.json({
      orderId: order.id,
      paymentMode: 'cod' as const,
      amountPaise: order.amountPaise,
      cart,
      serviceability,
    });
  }

  try {
    const rzpOrder = await createRazorpayOrder({
      amountPaise: order.amountPaise,
      receipt: order.id,
      notes: {
        localOrderId: order.id,
        pincode: address.pincode,
        city: address.city,
      },
    });
    attachRazorpayOrder(order.id, rzpOrder.id);

    return NextResponse.json({
      orderId: order.id,
      paymentMode: 'online' as const,
      razorpayOrderId: rzpOrder.id,
      amountPaise: order.amountPaise,
      currency: 'INR',
      cart,
      serviceability,
      prefill: {
        name: address.fullName,
        email: address.email,
        contact: address.phone,
      },
    });
  } catch (err) {
    console.error('[orders] Razorpay order creation failed', err);
    return NextResponse.json(
      { error: 'Could not start the payment. Please try again.' },
      { status: 502 },
    );
  }
}
