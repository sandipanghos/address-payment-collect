/**
 * The payment-method layout for Checkout.
 *
 * This is the file that makes the sheet look like a quick-commerce checkout
 * rather than Razorpay's default list. Two things drive the design:
 *
 * 1. UPI goes first, in Intent flow. Intent deep-links straight into the
 *    customer's UPI app and converts at roughly 85-95%; Collect, which asks
 *    them to type a VPA and then hunt for a notification, lands around 60-75%.
 *    That spread dwarfs any other optimisation available here. Razorpay's own
 *    docs now mark Collect as deprecated, and from February 2026 NPCI
 *    restricts manual VPA entry on mobile, so Intent is also where the rules
 *    are heading.
 *
 * 2. Everything else is ordered by how much Indian shoppers actually use it:
 *    cards, then netbanking, then wallets, then pay-later.
 */

/**
 * UPI apps are addressed by Android package name, not by brand slug.
 *
 * The `apps` array drives the app tiles on Android, where the intent handoff is
 * native. On desktop Razorpay falls back to a QR code and on iOS to the
 * platform's own app list — the same config covers all three, so there is no
 * separate desktop branch to maintain.
 */
export const UPI_APPS = {
  googlePay: 'com.google.android.apps.nbu.paisa.user',
  phonePe: 'com.phonepe.app',
  paytm: 'net.one97.paytm',
  bhim: 'in.org.npci.upiapp',
} as const;

/** Covers the large majority of netbanking volume; the rest sit behind "Other". */
export const TOP_BANKS = {
  hdfc: 'HDFC',
  icici: 'ICIC',
  sbi: 'SBIN',
  axis: 'UTIB',
  kotak: 'KKBK',
} as const;

export interface CheckoutDisplayConfig {
  display: {
    blocks: Record<
      string,
      {
        name: string;
        instruments: Array<Record<string, unknown>>;
      }
    >;
    sequence: string[];
    preferences: { show_default_blocks: boolean };
  };
}

export function buildCheckoutConfig(): CheckoutDisplayConfig {
  return {
    display: {
      blocks: {
        upi: {
          name: 'Pay by UPI',
          instruments: [
            {
              method: 'upi',
              flows: ['intent'],
              apps: [UPI_APPS.googlePay, UPI_APPS.phonePe, UPI_APPS.paytm, UPI_APPS.bhim],
            },
            // QR is what desktop browsers get; harmless on mobile.
            { method: 'upi', flows: ['qr'] },
          ],
        },
        cards: {
          name: 'Credit & Debit Cards',
          instruments: [{ method: 'card', types: ['credit', 'debit'] }],
        },
        netbanking: {
          name: 'Netbanking',
          instruments: [{ method: 'netbanking', banks: Object.values(TOP_BANKS) }],
        },
        wallets: {
          name: 'Wallets',
          instruments: [
            { method: 'wallet', wallets: ['phonepe', 'amazonpay', 'mobikwik', 'olamoney'] },
          ],
        },
        paylater: {
          name: 'Pay Later',
          instruments: [{ method: 'paylater' }],
        },
      },
      sequence: [
        'block.upi',
        'block.cards',
        'block.netbanking',
        'block.wallets',
        'block.paylater',
      ],
      /**
       * Left on so that banks outside TOP_BANKS and methods not named above
       * still appear below the curated blocks. Turning it off produces a
       * tidier sheet and a "my bank isn't listed" support ticket.
       */
      preferences: { show_default_blocks: true },
    },
  };
}
