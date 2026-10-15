# Address + Payment Collection (India)

Next.js checkout that collects an Indian shipping address and takes payment via
Razorpay — UPI Intent (GPay / PhonePe / Paytm), cards, netbanking, wallets,
pay-later, and cash on delivery.

## Setup

```bash
npm install
cp .env.example .env.local   # fill in your Razorpay test keys
npm run dev
```

Keys come from **Razorpay Dashboard → Account & Settings → API Keys**. Use
`rzp_test_*` keys until you go live.

For webhooks in development, expose the local server and point a webhook at it:

```bash
npx ngrok http 3000
# Dashboard → Settings → Webhooks → https://<id>.ngrok.app/api/webhooks/razorpay
# Subscribe to: payment.captured, payment.failed, order.paid, refund.processed
```

The webhook secret is a value *you* choose when creating the webhook. It is not
the API key secret, and the two are checked against different signatures.

## How a payment flows

```
browser                    server                      Razorpay
   │                          │                            │
   ├─ POST /api/orders ──────▶│                            │
   │   ids + address only     ├─ validate address          │
   │                          ├─ check PIN serviceability  │
   │                          ├─ price cart server-side    │
   │                          ├─ orders.create ───────────▶│
   │◀──── razorpayOrderId ────┤                            │
   │                                                       │
   ├─ Checkout sheet opens ───────────────────────────────▶│
   │   UPI Intent → GPay / PhonePe / Paytm                 │
   │                                                       │
   │◀─── handler(signature) ───────────────────────────────┤
   ├─ POST /api/payments/verify ─▶ signature check         │
   │                          │   status = authorized      │
   │                          │                            │
   │                          │◀── webhook payment.captured┤
   │                          ├─ status = paid             │
   │                          └─ fulfil (once)             │
   │                                                       │
   ├─ poll /api/orders/[id] until paid                     │
```

### The webhook is the source of truth

`/api/payments/verify` exists so the shopper sees a result immediately. It does
**not** fulfil the order. The browser callback is unreliable — tabs close,
networks drop, and the money still moves. Only `payment.captured` / `order.paid`
arriving at `/api/webhooks/razorpay` promotes an order to `paid` and triggers
fulfilment, because Razorpay retries webhooks and does not retry the browser.

## Design decisions worth knowing

**The client never sends a price.** `POST /api/orders` accepts product ids and
quantities; [`src/lib/catalog.ts`](src/lib/catalog.ts) computes the amount. A
client-supplied amount is the most commonly exploited hole in a payment
integration.

**All money is integer paise.** See [`src/lib/money.ts`](src/lib/money.ts).
Floats produce off-by-a-paisa charges and reconciliation mismatches.

**UPI goes first, in Intent flow.**
[`src/lib/checkout-config.ts`](src/lib/checkout-config.ts) lays out the payment
sheet. Intent deep-links into the customer's UPI app and converts at roughly
85–95%; Collect — type a VPA, then find the notification — lands near 60–75%.
Razorpay marks Collect deprecated, and from February 2026 NPCI restricts manual
VPA entry on mobile. UPI apps are addressed by Android package name
(`com.phonepe.app`), not brand slug.

**Serviceability is checked before the payment sheet opens.**
[`src/lib/pincode.ts`](src/lib/pincode.ts) rejects undeliverable PIN codes and
decides COD eligibility. Taking money for an address no courier serves means a
refund, a lost gateway fee, and a lost customer.

**Webhooks are replay- and reorder-safe.** Event ids are deduplicated, status
transitions are monotonic (a late `payment.failed` cannot un-pay a paid order),
and fulfilment is guarded by a one-shot flag.

**Signature failures return 400, misconfiguration returns 500.** A forged
payload will never become valid, so a 5xx would make Razorpay redeliver it
forever. A missing secret is genuinely ours to fix, and there the retry is
wanted.

**The address is snapshotted onto the order**, not referenced. Customers edit
saved addresses; the address a parcel shipped to must not change retroactively.

## Before going live

- [ ] **Replace the in-memory store** in [`src/lib/orders.ts`](src/lib/orders.ts)
      with your database. It does not survive a restart and does not work across
      more than one instance.
- [ ] **Replace `checkCourier`** in [`src/lib/pincode.ts`](src/lib/pincode.ts)
      with your courier's real serviceability API (Shiprocket, Delhivery,
      Bluedart, Ekart).
- [ ] Move fulfilment side effects onto a queue. Razorpay times out slow webhook
      handlers and retries, which produces duplicates.
- [ ] Add rate limiting to `/api/orders` and `/api/serviceability`.
- [ ] Reconcile daily against Razorpay settlements.
- [ ] Complete Razorpay KYC and switch to live keys.
- [ ] Confirm your UPI MDR terms in writing — see below.

## Two live regulatory items

**UPI is no longer free above ₹2,000.** NPCI's 0.4% MDR on P2M transactions
above ₹2,000 (capped at ₹300) was set for 15 October 2026 and has been deferred
to after Diwali, date to be announced. Consumers pay nothing and merchants are
barred from passing it on, so it comes out of margin.
[`estimatedUpiMdrPaise`](src/lib/money.ts) models it for your own reporting —
it is never added to the charged amount. Transactions at or below ₹2,000 remain
free, which makes your average order value a pricing input.

**You cannot store card numbers.** Since October 2022 RBI's card-on-file
tokenization mandate bars every party except the issuer and card network from
storing PAN, CVV or expiry. Razorpay's hosted sheet keeps card data out of this
codebase entirely; do not add a card form.

## Layout

```
src/
├── app/
│   ├── page.tsx                        cart + checkout entry
│   └── api/
│       ├── orders/route.ts             create order, price it, gate on PIN
│       ├── orders/[id]/route.ts        status polling
│       ├── payments/verify/route.ts    verify browser callback (no fulfilment)
│       ├── webhooks/razorpay/route.ts  source of truth, fulfilment
│       └── serviceability/route.ts     PIN lookup, city/state prefill
├── components/Checkout.tsx             address form + Checkout sheet
└── lib/
    ├── catalog.ts          server-side prices
    ├── checkout-config.ts  UPI-first payment-method layout
    ├── money.ts            paise arithmetic, UPI MDR model
    ├── orders.ts           order state machine (swap for a DB)
    ├── pincode.ts          serviceability + COD (swap for courier API)
    ├── razorpay.ts         client, signature verification
    └── validation.ts       Indian address schema
```
