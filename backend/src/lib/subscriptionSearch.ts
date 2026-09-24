export const normalizeSubscriptionSearch = (value: string): string =>
  value.trim().replace(/\s+/g, ' ').toLowerCase();
