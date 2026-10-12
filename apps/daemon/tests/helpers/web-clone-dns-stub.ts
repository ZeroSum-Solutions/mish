// A stub resolver for the Website Clone target check (D15), so daemon tests
// make no real DNS query. Known public test hosts answer with a public
// address; every other host fails like an unknown name (ENOTFOUND).

const PUBLIC_ANSWERS: Record<string, string> = {
  'example.com': '93.184.215.14',
  'mish.invalid': '76.76.21.21',
  'stripe.com': '185.166.143.1',
};

function dnsError(code: string, host: string): Error {
  return Object.assign(new Error(`${code} ${host}`), { code, hostname: host });
}

export async function stubWebCloneLookup(host: string): Promise<Array<{ address: string }>> {
  const address = PUBLIC_ANSWERS[host.toLowerCase()];
  if (address) return [{ address }];
  throw dnsError('ENOTFOUND', host);
}

export { dnsError };
