import type { Paise } from './money';

/**
 * The server-side price list.
 *
 * The client sends product ids and quantities — never prices. Trusting a
 * client-supplied amount is the single most common way a payment integration
 * gets exploited: the attacker edits the request and buys a Rs 2,000 item for
 * Rs 1. Every amount charged is recomputed here from these values.
 *
 * Swap this for your real product table; keep the shape.
 */
export interface Product {
  id: string;
  name: string;
  pricePaise: Paise;
}

const CATALOG: ReadonlyMap<string, Product> = new Map(
  (
    [
      { id: 'sku-tea-250g', name: 'Assam Tea 250g', pricePaise: 24_900 },
      { id: 'sku-ghee-500ml', name: 'Cow Ghee 500ml', pricePaise: 64_500 },
      { id: 'sku-almond-500g', name: 'Almonds 500g', pricePaise: 89_900 },
      { id: 'sku-honey-1kg', name: 'Raw Honey 1kg', pricePaise: 54_000 },
    ] satisfies Product[]
  ).map((p) => [p.id, p]),
);

export function getProduct(id: string): Product | undefined {
  return CATALOG.get(id);
}

export function listProducts(): Product[] {
  return [...CATALOG.values()];
}

export interface CartLine {
  productId: string;
  quantity: number;
}

export interface PricedLine {
  productId: string;
  name: string;
  quantity: number;
  unitPricePaise: Paise;
  linePaise: Paise;
}

export interface PricedCart {
  lines: PricedLine[];
  subtotalPaise: Paise;
  shippingPaise: Paise;
  totalPaise: Paise;
}

/** Free shipping above this subtotal, flat fee below it. */
const FREE_SHIPPING_THRESHOLD_PAISE: Paise = 50_000;
const FLAT_SHIPPING_PAISE: Paise = 4_900;

export class CatalogError extends Error {}

export function priceCart(lines: CartLine[]): PricedCart {
  if (lines.length === 0) throw new CatalogError('Cart is empty');

  const priced: PricedLine[] = lines.map((line) => {
    const product = getProduct(line.productId);
    if (!product) throw new CatalogError(`Unknown product: ${line.productId}`);
    if (!Number.isInteger(line.quantity) || line.quantity < 1 || line.quantity > 20) {
      throw new CatalogError(`Invalid quantity for ${line.productId}`);
    }
    return {
      productId: product.id,
      name: product.name,
      quantity: line.quantity,
      unitPricePaise: product.pricePaise,
      linePaise: product.pricePaise * line.quantity,
    };
  });

  const subtotalPaise = priced.reduce((sum, l) => sum + l.linePaise, 0);
  const shippingPaise =
    subtotalPaise >= FREE_SHIPPING_THRESHOLD_PAISE ? 0 : FLAT_SHIPPING_PAISE;

  return {
    lines: priced,
    subtotalPaise,
    shippingPaise,
    totalPaise: subtotalPaise + shippingPaise,
  };
}
