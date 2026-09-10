const PRIVATE_KEY = /^0x[0-9a-fA-F]{64}$/;

export function isPrivateKey(value: string): value is `0x${string}` {
  return PRIVATE_KEY.test(value);
}
