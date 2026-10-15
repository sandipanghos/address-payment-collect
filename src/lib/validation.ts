import { z } from 'zod';

/** The 28 states and 8 union territories, as written on Indian address labels. */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

/** Indian mobile numbers are 10 digits starting 6-9. Accepts a +91 / 0 prefix. */
const phoneSchema = z
  .string()
  .trim()
  .transform((v) => v.replace(/[\s-]/g, '').replace(/^(\+91|0091|91|0)/, ''))
  .pipe(
    z
      .string()
      .regex(/^[6-9]\d{9}$/, 'Enter a valid 10-digit Indian mobile number'),
  );

/** PIN codes are 6 digits and never start with 0. */
export const pincodeSchema = z
  .string()
  .trim()
  .regex(/^[1-9]\d{5}$/, 'Enter a valid 6-digit PIN code');

export const shippingAddressSchema = z.object({
  fullName: z.string().trim().min(2, 'Enter the full name').max(100),
  phone: phoneSchema,
  email: z.string().trim().email('Enter a valid email').max(200),
  line1: z.string().trim().min(3, 'Enter the flat, house or building').max(200),
  line2: z.string().trim().max(200).optional().default(''),
  landmark: z.string().trim().max(120).optional().default(''),
  city: z.string().trim().min(2, 'Enter the city').max(80),
  state: z.enum(INDIAN_STATES, { errorMap: () => ({ message: 'Select a state' }) }),
  pincode: pincodeSchema,
  country: z.literal('IN').default('IN'),
});

export type ShippingAddress = z.infer<typeof shippingAddressSchema>;

export const cartLineSchema = z.object({
  productId: z.string().trim().min(1),
  quantity: z.number().int().min(1).max(20),
});

/**
 * Note what is absent: no amount, no price, no total. The client states what it
 * wants to buy and where to send it; the server decides what that costs.
 */
export const createOrderSchema = z.object({
  lines: z.array(cartLineSchema).min(1).max(50),
  address: shippingAddressSchema,
  paymentMode: z.enum(['online', 'cod']).default('online'),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;

/** Collapses a Zod error into a field -> message map the form can render. */
export function fieldErrors(error: z.ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of error.issues) {
    const key = issue.path.join('.') || '_';
    out[key] ??= issue.message;
  }
  return out;
}
