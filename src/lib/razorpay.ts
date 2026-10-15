import Razorpay from 'razorpay';
import { createHmac, timingSafeEqual } from 'node:crypto';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

let client: Razorpay | null = null;

/** Lazily constructed so that importing this module never throws at build time. */
export function razorpay(): Razorpay {
  client ??= new Razorpay({
    key_id: required('RAZORPAY_KEY_ID'),
    key_secret: required('RAZORPAY_KEY_SECRET'),
  });
  return client;
}

/** Compares two hex digests without leaking their contents through timing. */
function safeEqualHex(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  if (left.length !== right.length || left.length === 0) return false;
  return timingSafeEqual(left, right);
}

/**
 * Verifies the signature returned to the browser by Checkout.
 *
 * Razorpay signs `order_id|payment_id` with your API secret. Without this check
 * anyone can POST a fabricated success to your verify endpoint.
 */
export function verifyCheckoutSignature(params: {
  razorpayOrderId: string;
  razorpayPaymentId: string;
  razorpaySignature: string;
}): boolean {
  const expected = createHmac('sha256', required('RAZORPAY_KEY_SECRET'))
    .update(`${params.razorpayOrderId}|${params.razorpayPaymentId}`)
    .digest('hex');
  return safeEqualHex(expected, params.razorpaySignature);
}

/** Raised when a signing secret is absent, to separate misconfiguration from forgery. */
export class MissingSecretError extends Error {}

/**
 * Wraps a verifier so a missing secret is distinguishable from a bad
 * signature.
 *
 * Without this the two collapse into one unhandled throw and the endpoint
 * returns 500 for a forged payload — which Razorpay treats as a transient
 * failure and retries indefinitely, burying a real misconfiguration under
 * redelivery noise.
 */
export function tryVerify(verify: () => boolean): boolean {
  try {
    return verify();
  } catch (err) {
    if (err instanceof Error && err.message.startsWith('Missing required environment')) {
      throw new MissingSecretError(err.message);
    }
    throw err;
  }
}

/**
 * Verifies a webhook.
 *
 * `rawBody` must be the exact bytes Razorpay sent. Re-serialising a parsed
 * object changes key order and whitespace and the HMAC will not match, so
 * route handlers read the body with `req.text()` and parse only afterwards.
 *
 * Note this uses the webhook secret you chose in the dashboard — a different
 * value from the API key secret used above.
 */
export function verifyWebhookSignature(rawBody: string, signature: string): boolean {
  const expected = createHmac('sha256', required('RAZORPAY_WEBHOOK_SECRET'))
    .update(rawBody)
    .digest('hex');
  return safeEqualHex(expected, signature);
}

export interface RazorpayOrder {
  id: string;
  amount: number;
  currency: string;
  receipt?: string;
  status: string;
}

/**
 * Creates the Razorpay order the browser will pay against.
 *
 * `receipt` carries our own order id, which makes the two systems reconcilable
 * from either side and gives Razorpay a natural idempotency anchor for retries.
 */
export async function createRazorpayOrder(input: {
  amountPaise: number;
  receipt: string;
  notes?: Record<string, string>;
}): Promise<RazorpayOrder> {
  const order = await razorpay().orders.create({
    amount: input.amountPaise,
    currency: 'INR',
    receipt: input.receipt,
    notes: input.notes,
  });
  return order as unknown as RazorpayOrder;
}
