export function applyDeliveryErrorPolicy(error: unknown, propagate: boolean): void {
  if (propagate) throw error;
}
