import { NextResponse } from 'next/server';
import { getOrder } from '@/lib/orders';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Polled by the confirmation screen while it waits for the webhook to promote
 * the order from `authorized` to `paid`. That gap is usually a second or two,
 * but it is the honest state of the world and the UI reflects it rather than
 * claiming success the moment the browser callback fires.
 */
export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const order = getOrder(id);
  if (!order) {
    return NextResponse.json({ error: 'Order not found' }, { status: 404 });
  }

  return NextResponse.json({
    orderId: order.id,
    status: order.status,
    amountPaise: order.amountPaise,
    paymentMode: order.paymentMode,
    paymentMethod: order.paymentMethod,
    fulfilled: order.fulfilled,
  });
}
