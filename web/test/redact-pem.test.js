// A PEM private key goes as a whole block (BEGIN and END lines too), and a header alone goes too, so a secret scanner
// never flags what is left of a redacted key. Synthetic keys only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets } from '../core/redact.js';

const BODY = 'EXAMPLE0b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW\nEXAMPLEQyNTUxOQAAACBEXAMPLEEXAMPLEEXAMPLE';
test('a whole PEM block becomes one marker, the text around it stays', () => {
  for (const kind of ['OPENSSH ', 'RSA ', 'EC ', '']) {
    const t = `before\n-----BEGIN ${kind}PRIVATE KEY-----\n${BODY}\n-----END ${kind}PRIVATE KEY-----\nafter`;
    assert.equal(redactSecrets(t), 'before\n[redacted private key]\nafter', kind);
  }
});
test('a header with no END in reach, or a stray END, still goes', () => {
  assert.equal(redactSecrets('-----BEGIN RSA PRIVATE KEY-----\nEXAMPLEcut here'), '[redacted private key]\nEXAMPLEcut here');
  assert.equal(redactSecrets('x -----END EC PRIVATE KEY----- y'), 'x [redacted private key] y');
});
test('a public key or a certificate is not a secret', () => {
  const pub = '-----BEGIN PUBLIC KEY-----\nEXAMPLE\n-----END PUBLIC KEY-----';
  assert.equal(redactSecrets(pub), pub);
});
