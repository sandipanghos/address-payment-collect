/** Checkout.js is loaded from Razorpay's CDN and attaches itself to window. */

export interface RazorpaySuccessResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

export interface RazorpayFailureResponse {
  error: {
    code: string;
    description: string;
    source: string;
    step: string;
    reason: string;
    metadata: { order_id?: string; payment_id?: string };
  };
}

export interface RazorpayOptions {
  key: string;
  amount: number;
  currency: string;
  name: string;
  description?: string;
  image?: string;
  order_id: string;
  handler: (response: RazorpaySuccessResponse) => void;
  prefill?: { name?: string; email?: string; contact?: string };
  notes?: Record<string, string>;
  theme?: { color?: string };
  config?: unknown;
  retry?: { enabled: boolean; max_count?: number };
  modal?: { ondismiss?: () => void; escape?: boolean; confirm_close?: boolean };
}

export interface RazorpayInstance {
  open: () => void;
  close: () => void;
  on: (
    event: 'payment.failed',
    handler: (response: RazorpayFailureResponse) => void,
  ) => void;
}

declare global {
  interface Window {
    Razorpay?: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

export {};
