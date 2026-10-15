'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { buildCheckoutConfig } from '@/lib/checkout-config';
import { formatINR } from '@/lib/money';
import { INDIAN_STATES } from '@/lib/validation';
import type { Serviceability } from '@/lib/pincode';
import type {
  RazorpayFailureResponse,
  RazorpaySuccessResponse,
} from '@/types/razorpay';

const CHECKOUT_JS = 'https://checkout.razorpay.com/v1/checkout.js';

interface CartItem {
  productId: string;
  name: string;
  quantity: number;
  pricePaise: number;
}

interface AddressState {
  fullName: string;
  phone: string;
  email: string;
  line1: string;
  line2: string;
  landmark: string;
  city: string;
  state: string;
  pincode: string;
}

const EMPTY_ADDRESS: AddressState = {
  fullName: '',
  phone: '',
  email: '',
  line1: '',
  line2: '',
  landmark: '',
  city: '',
  state: '',
  pincode: '',
};

/**
 * Matches India Post's state spelling to the dropdown's.
 *
 * The two registries disagree in small ways — India Post returns
 * "Andaman & Nicobar" where the dropdown has "Andaman and Nicobar Islands",
 * and punctuation varies elsewhere. Normalising both sides and allowing a
 * prefix match covers the differences; anything still unmatched simply leaves
 * the field blank for the customer to pick.
 */
function matchState(reported: string | undefined): string {
  if (!reported) return '';
  const normalise = (s: string) =>
    s.toLowerCase().replace(/&/g, 'and').replace(/[^a-z]/g, '');
  const target = normalise(reported);
  if (!target) return '';

  return (
    (INDIAN_STATES as readonly string[]).find((s) => {
      const candidate = normalise(s);
      return candidate === target || candidate.startsWith(target) || target.startsWith(candidate);
    }) ?? ''
  );
}

/** Loads Checkout.js once and resolves when window.Razorpay exists. */
function loadCheckoutScript(): Promise<void> {
  if (typeof window === 'undefined') return Promise.resolve();
  if (window.Razorpay) return Promise.resolve();

  return new Promise((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${CHECKOUT_JS}"]`,
    );
    if (existing) {
      existing.addEventListener('load', () => resolve());
      existing.addEventListener('error', () => reject(new Error('script failed')));
      return;
    }
    const script = document.createElement('script');
    script.src = CHECKOUT_JS;
    script.async = true;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Could not load the payment library'));
    document.body.appendChild(script);
  });
}

export default function Checkout({ cart }: { cart: CartItem[] }) {
  const [address, setAddress] = useState<AddressState>(EMPTY_ADDRESS);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [banner, setBanner] = useState<{ kind: 'error' | 'success'; text: string } | null>(
    null,
  );
  const [serviceability, setServiceability] = useState<Serviceability | null>(null);
  const [checkingPin, setCheckingPin] = useState(false);
  const [paymentMode, setPaymentMode] = useState<'online' | 'cod'>('online');
  const [busy, setBusy] = useState(false);

  const pinRequestId = useRef(0);

  const subtotal = cart.reduce((sum, i) => sum + i.pricePaise * i.quantity, 0);
  const shipping = subtotal >= 50_000 ? 0 : 4_900;
  const total = subtotal + shipping;

  // Preload the payment library so the sheet opens instantly on tap rather
  // than after a cold network fetch.
  useEffect(() => {
    loadCheckoutScript().catch(() => {
      /* surfaced on pay instead — no need to alarm anyone up front */
    });
  }, []);

  const set = (key: keyof AddressState) => (value: string) => {
    setAddress((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => {
      if (!prev[key]) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };

  /**
   * Looks the PIN code up as soon as it is six digits long: fills city and
   * state, surfaces the delivery estimate, and establishes whether COD is on
   * the table. Stale responses are discarded by request id, since a customer
   * correcting a typo can easily have two lookups in flight.
   */
  useEffect(() => {
    const pin = address.pincode.trim();
    if (!/^[1-9]\d{5}$/.test(pin)) {
      setServiceability(null);
      return;
    }

    const requestId = ++pinRequestId.current;
    setCheckingPin(true);

    const timer = setTimeout(() => {
      fetch(`/api/serviceability?pincode=${pin}`)
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error('lookup failed'))))
        .then((data: Serviceability) => {
          if (requestId !== pinRequestId.current) return;
          setServiceability(data);
          setAddress((prev) => ({
            ...prev,
            city: prev.city || data.city || '',
            state: prev.state || matchState(data.state),
          }));
          if (!data.codAvailable) setPaymentMode('online');
        })
        .catch(() => {
          if (requestId === pinRequestId.current) setServiceability(null);
        })
        .finally(() => {
          if (requestId === pinRequestId.current) setCheckingPin(false);
        });
    }, 250);

    return () => clearTimeout(timer);
  }, [address.pincode]);

  /** Polls until the webhook promotes the order to a terminal state. */
  const awaitSettlement = useCallback(async (orderId: string) => {
    for (let attempt = 0; attempt < 10; attempt++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const res = await fetch(`/api/orders/${orderId}`, { cache: 'no-store' });
        if (!res.ok) continue;
        const data = (await res.json()) as { status: string };
        if (data.status === 'paid') {
          setBanner({ kind: 'success', text: `Payment confirmed. Order ${orderId}.` });
          return;
        }
        if (data.status === 'failed') {
          setBanner({ kind: 'error', text: 'The payment did not go through.' });
          return;
        }
      } catch {
        /* keep polling */
      }
    }
    // Authorised but not yet captured. Say so plainly rather than inventing
    // a confirmation — the money is accounted for either way.
    setBanner({
      kind: 'success',
      text: `Payment received. Order ${orderId} is being confirmed.`,
    });
  }, []);

  const pay = async () => {
    setBusy(true);
    setBanner(null);
    setErrors({});

    try {
      const res = await fetch('/api/orders', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          // Ids and quantities only. The server prices the cart.
          lines: cart.map((i) => ({ productId: i.productId, quantity: i.quantity })),
          address: { ...address, country: 'IN' },
          paymentMode,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setErrors(data.fields ?? {});
        setBanner({ kind: 'error', text: data.error ?? 'Could not place the order' });
        return;
      }

      if (data.paymentMode === 'cod') {
        setBanner({
          kind: 'success',
          text: `Order ${data.orderId} placed. Pay ${formatINR(data.amountPaise)} on delivery.`,
        });
        return;
      }

      await loadCheckoutScript();
      if (!window.Razorpay) throw new Error('Payment library unavailable');

      const rzp = new window.Razorpay({
        key: process.env.NEXT_PUBLIC_RAZORPAY_KEY_ID ?? '',
        amount: data.amountPaise,
        currency: data.currency,
        name: 'Your Store',
        description: `Order ${data.orderId}`,
        order_id: data.razorpayOrderId,
        prefill: data.prefill,
        notes: { localOrderId: data.orderId },
        theme: { color: '#1a73e8' },
        // UPI-first layout with Intent app tiles. See lib/checkout-config.ts.
        config: buildCheckoutConfig(),
        // Lets a shopper retry inside the sheet after a bank declines, instead
        // of dropping them back to the form.
        retry: { enabled: true, max_count: 3 },
        handler: async (response: RazorpaySuccessResponse) => {
          const verify = await fetch('/api/payments/verify', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(response),
          });
          if (!verify.ok) {
            setBanner({
              kind: 'error',
              text: 'We could not verify this payment. Please contact support before retrying.',
            });
            return;
          }
          setBanner({ kind: 'success', text: 'Payment received. Confirming…' });
          void awaitSettlement(data.orderId);
        },
        modal: {
          ondismiss: () => {
            setBusy(false);
            setBanner({ kind: 'error', text: 'Payment cancelled.' });
          },
        },
      });

      rzp.on('payment.failed', (failure: RazorpayFailureResponse) => {
        setBanner({
          kind: 'error',
          text: failure.error?.description ?? 'The payment failed. Please try another method.',
        });
      });

      rzp.open();
    } catch (err) {
      setBanner({
        kind: 'error',
        text: err instanceof Error ? err.message : 'Something went wrong',
      });
    } finally {
      setBusy(false);
    }
  };

  const blocked = serviceability !== null && !serviceability.serviceable;

  return (
    <div className="page">
      <h1>Checkout</h1>
      <p className="sub">Delivery address and payment</p>

      {banner && <div className={`banner ${banner.kind}`}>{banner.text}</div>}

      <section className="card">
        <h2>Order summary</h2>
        {cart.map((item) => (
          <div className="line" key={item.productId}>
            <span>
              {item.name} <span className="qty">× {item.quantity}</span>
            </span>
            <span>{formatINR(item.pricePaise * item.quantity)}</span>
          </div>
        ))}
        <div className="line">
          <span>Delivery</span>
          <span>{shipping === 0 ? 'Free' : formatINR(shipping)}</span>
        </div>
        <div className="line total">
          <span>Total</span>
          <span>{formatINR(total)}</span>
        </div>
      </section>

      <section className="card">
        <h2>Delivery address</h2>

        <Field label="Full name" error={errors['address.fullName']}>
          <input
            value={address.fullName}
            onChange={(e) => set('fullName')(e.target.value)}
            autoComplete="name"
            aria-invalid={Boolean(errors['address.fullName'])}
          />
        </Field>

        <div className="row">
          <Field label="Mobile number" error={errors['address.phone']}>
            <input
              value={address.phone}
              onChange={(e) => set('phone')(e.target.value)}
              inputMode="numeric"
              autoComplete="tel-national"
              placeholder="10-digit number"
              maxLength={13}
              aria-invalid={Boolean(errors['address.phone'])}
            />
          </Field>
          <Field label="Email" error={errors['address.email']}>
            <input
              value={address.email}
              onChange={(e) => set('email')(e.target.value)}
              type="email"
              autoComplete="email"
              aria-invalid={Boolean(errors['address.email'])}
            />
          </Field>
        </div>

        <Field label="PIN code" error={errors['address.pincode'] ?? errors.pincode}>
          <input
            value={address.pincode}
            onChange={(e) => set('pincode')(e.target.value.replace(/\D/g, '').slice(0, 6))}
            inputMode="numeric"
            autoComplete="postal-code"
            maxLength={6}
            aria-invalid={Boolean(errors['address.pincode'] ?? errors.pincode)}
          />
          {checkingPin && <p className="hint">Checking delivery…</p>}
          {serviceability?.serviceable && (
            <p className="hint ok">
              Delivers in {serviceability.etaDaysMin}–{serviceability.etaDaysMax} business days
              {serviceability.codAvailable ? ' · Cash on delivery available' : ''}
            </p>
          )}
          {blocked && (
            <p className="err">
              {serviceability?.reason ?? 'We do not deliver to this PIN code yet.'}
            </p>
          )}
        </Field>

        <Field label="Flat, house no., building" error={errors['address.line1']}>
          <input
            value={address.line1}
            onChange={(e) => set('line1')(e.target.value)}
            autoComplete="address-line1"
            aria-invalid={Boolean(errors['address.line1'])}
          />
        </Field>

        <Field label="Area, street, sector (optional)" error={errors['address.line2']}>
          <input
            value={address.line2}
            onChange={(e) => set('line2')(e.target.value)}
            autoComplete="address-line2"
          />
        </Field>

        <Field label="Landmark (optional)" error={errors['address.landmark']}>
          <input
            value={address.landmark}
            onChange={(e) => set('landmark')(e.target.value)}
            placeholder="e.g. opposite the metro station"
          />
        </Field>

        <div className="row">
          <Field label="City" error={errors['address.city']}>
            <input
              value={address.city}
              onChange={(e) => set('city')(e.target.value)}
              autoComplete="address-level2"
              aria-invalid={Boolean(errors['address.city'])}
            />
          </Field>
          <Field label="State" error={errors['address.state']}>
            <select
              value={address.state}
              onChange={(e) => set('state')(e.target.value)}
              aria-invalid={Boolean(errors['address.state'])}
            >
              <option value="">Select state</option>
              {INDIAN_STATES.map((s) => (
                <option key={s} value={s}>
                  {s}
                </option>
              ))}
            </select>
          </Field>
        </div>
      </section>

      <section className="card">
        <h2>Payment</h2>
        <div className="modes">
          <button
            type="button"
            className="mode"
            aria-pressed={paymentMode === 'online'}
            onClick={() => setPaymentMode('online')}
          >
            Pay online
          </button>
          <button
            type="button"
            className="mode"
            aria-pressed={paymentMode === 'cod'}
            disabled={!serviceability?.codAvailable}
            onClick={() => setPaymentMode('cod')}
          >
            Cash on delivery
          </button>
        </div>
        {paymentMode === 'online' && (
          <div className="methods">
            <span className="chip">UPI · GPay</span>
            <span className="chip">PhonePe</span>
            <span className="chip">Paytm</span>
            <span className="chip">Cards</span>
            <span className="chip">Netbanking</span>
            <span className="chip">Wallets</span>
            <span className="chip">Pay Later</span>
          </div>
        )}
      </section>

      <div className="pay">
        <div className="pay-inner">
          <button className="primary" onClick={pay} disabled={busy || blocked}>
            {busy
              ? 'Please wait…'
              : paymentMode === 'cod'
                ? `Place order · ${formatINR(total)}`
                : `Pay ${formatINR(total)}`}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="field">
      <label>{label}</label>
      {children}
      {error && <p className="err">{error}</p>}
    </div>
  );
}
