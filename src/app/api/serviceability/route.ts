import { NextResponse } from 'next/server';
import { getServiceability } from '@/lib/pincode';
import { pincodeSchema } from '@/lib/validation';

export const runtime = 'nodejs';

/**
 * Called as the customer finishes typing their PIN code, so the form can
 * prefill city and state and warn about non-delivery before they commit.
 */
export async function GET(req: Request) {
  const pincode = new URL(req.url).searchParams.get('pincode') ?? '';

  const parsed = pincodeSchema.safeParse(pincode);
  if (!parsed.success) {
    return NextResponse.json(
      { error: parsed.error.issues[0]?.message ?? 'Invalid PIN code' },
      { status: 400 },
    );
  }

  const result = await getServiceability(parsed.data);
  return NextResponse.json(result);
}
