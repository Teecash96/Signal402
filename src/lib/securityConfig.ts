export function isUsableSecret(value: string | undefined, minimumBytes = 32): value is string {
  if (!value) return false;
  return Buffer.byteLength(value, 'utf8') >= minimumBytes
    && !/^(replace-with|changeme|change-me|your[-_]|example[-_])/i.test(value);
}
