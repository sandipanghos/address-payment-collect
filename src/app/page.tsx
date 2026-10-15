import Checkout from '@/components/Checkout';
import { listProducts } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

/**
 * Stands in for whatever puts items in a basket in your app. The cart is built
 * on the server from the catalogue so the prices rendered here are the same
 * ones the order endpoint will charge.
 */
export default function Page() {
  const products = listProducts();

  const cart = [
    { ...products[0], quantity: 2 },
    { ...products[1], quantity: 1 },
  ].map((p) => ({
    productId: p.id,
    name: p.name,
    quantity: p.quantity,
    pricePaise: p.pricePaise,
  }));

  return <Checkout cart={cart} />;
}
