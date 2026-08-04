function randomHex(bytes: number): string | null {
  const cryptoApi = globalThis.crypto;
  if (!cryptoApi?.getRandomValues) return null;

  const values = new Uint8Array(bytes);
  cryptoApi.getRandomValues(values);
  return Array.from(values, (value) => value.toString(16).padStart(2, '0')).join('');
}

export function createClientId(prefix?: string): string {
  const cryptoApi = globalThis.crypto;
  const randomUUID = cryptoApi?.randomUUID;
  const id =
    typeof randomUUID === 'function'
      ? randomUUID.call(cryptoApi)
      : (randomHex(16) ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`);

  return prefix ? `${prefix}-${id}` : id;
}
