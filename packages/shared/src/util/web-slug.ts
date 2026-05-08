const ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";

export function generateWebSlug(): string {
  return Array.from(
    { length: 8 },
    () => ALPHABET[Math.floor(Math.random() * ALPHABET.length)],
  ).join("");
}
