// The agentmail SDK can optionally use "@x402/fetch" (a crypto-payments
// helper) — a feature this project never touches. The SDK only loads it
// lazily, but the bundler still insists the module exists. This stub
// satisfies the bundler; if the SDK ever actually called it, we'd rather
// fail loudly than silently do payments.
export function wrapFetchWithPayment(): never {
  throw new Error("x402 payments are not enabled in this project");
}
export function x402HTTPClient(): never {
  throw new Error("x402 payments are not enabled in this project");
}
