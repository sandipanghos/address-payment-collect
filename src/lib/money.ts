/**
 * All money in this codebase is an integer count of paise.
 *
 * Razorpay's API takes and returns paise. Representing currency as a float
 * anywhere in the pipeline eventually produces a charge that is off by a paisa
 * and a reconciliation mismatch that is painful to trace, so there is no
 * rupee-typed value in the system — only paise, converted at the display edge.
 */

export type Paise = number;

export function rupeesToPaise(rupees: number): Paise {
  return Math.round(rupees * 100);
}

/** Display only. Never feed the result back into a calculation. */
export function formatINR(paise: Paise): string {
  return new Intl.NumberFormat('en-IN', {
    style: 'currency',
    currency: 'INR',
    minimumFractionDigits: 2,
  }).format(paise / 100);
}

/**
 * NPCI levies 0.4% MDR on UPI P2M transactions above Rs 2,000, capped at
 * Rs 300. Merchants are barred from passing it on to the customer, so this is
 * a margin figure for your own reporting — never add it to the charged amount.
 */
export const UPI_MDR_THRESHOLD_PAISE: Paise = 200_000;
export const UPI_MDR_RATE = 0.004;
export const UPI_MDR_CAP_PAISE: Paise = 30_000;

export function estimatedUpiMdrPaise(amount: Paise): Paise {
  if (amount <= UPI_MDR_THRESHOLD_PAISE) return 0;
  return Math.min(Math.round(amount * UPI_MDR_RATE), UPI_MDR_CAP_PAISE);
}
