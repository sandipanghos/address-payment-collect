/**
 * PIN code serviceability.
 *
 * Collecting payment for an address no courier delivers to is the most
 * expensive failure mode in Indian e-commerce — you refund, you eat the
 * gateway fee, and you lose the customer. So serviceability is checked before
 * the payment sheet opens, not after.
 *
 * The lookup below is a deliberately simple stand-in. Replace `checkCourier`
 * with your courier's real API (Shiprocket, Delhivery, Bluedart and Ekart all
 * expose a serviceability endpoint keyed by PIN code) and the rest of the
 * pipeline needs no changes.
 */

export interface Serviceability {
  pincode: string;
  serviceable: boolean;
  codAvailable: boolean;
  /** Courier's own estimate, in business days. */
  etaDaysMin: number;
  etaDaysMax: number;
  city?: string;
  state?: string;
  reason?: string;
}

/**
 * Stand-in rules. PIN codes are allocated by region via the first digit, so
 * this at least behaves plausibly per zone while you wire the real API.
 */
const COD_BLOCKED_PREFIXES = ['744', '682', '796', '737'];

async function checkCourier(pincode: string): Promise<Omit<Serviceability, 'city' | 'state'>> {
  const firstDigit = Number(pincode[0]);

  // Zones 1-8 are mainland postal circles; 9 is Army Postal Service.
  if (firstDigit === 9) {
    return {
      pincode,
      serviceable: false,
      codAvailable: false,
      etaDaysMin: 0,
      etaDaysMax: 0,
      reason: 'APO addresses are not serviceable',
    };
  }

  const remote = COD_BLOCKED_PREFIXES.some((p) => pincode.startsWith(p));

  return {
    pincode,
    serviceable: true,
    codAvailable: !remote,
    etaDaysMin: remote ? 5 : 2,
    etaDaysMax: remote ? 9 : 5,
  };
}

/**
 * India Post's public PIN directory, used to prefill city and state.
 *
 * It is free and unauthenticated, which also means it is occasionally slow or
 * down. It is strictly an autofill convenience, so every failure path here
 * returns undefined rather than throwing — a customer must always be able to
 * type the city themselves.
 */
async function lookupPostal(
  pincode: string,
): Promise<{ city?: string; state?: string }> {
  try {
    const res = await fetch(`https://api.postalpincode.in/pincode/${pincode}`, {
      signal: AbortSignal.timeout(2500),
      next: { revalidate: 60 * 60 * 24 },
    });
    if (!res.ok) return {};

    const body = (await res.json()) as Array<{
      Status?: string;
      PostOffice?: Array<{ District?: string; State?: string }> | null;
    }>;

    const office = body?.[0]?.PostOffice?.[0];
    if (body?.[0]?.Status !== 'Success' || !office) return {};

    return { city: office.District, state: office.State };
  } catch {
    return {};
  }
}

export async function getServiceability(pincode: string): Promise<Serviceability> {
  const [courier, postal] = await Promise.all([
    checkCourier(pincode),
    lookupPostal(pincode),
  ]);
  return { ...courier, ...postal };
}
