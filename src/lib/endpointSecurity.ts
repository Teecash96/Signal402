export function validateSellerEndpoint(endpoint: string): void {
  const parsed = new URL(endpoint);
  const loopback = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '::1';
  if (parsed.protocol !== 'https:' && !loopback) {
    throw new Error('SELLER_ENDPOINT_URL must use HTTPS outside loopback development');
  }
}
