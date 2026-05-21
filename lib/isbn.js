// ISBN helpers for building external retailer links.

// Convert an ISBN-13 (only 978-prefix) to ISBN-10. Amazon's product URLs use
// ISBN-10 (a.k.a. ASIN for books), so we need this for direct /dp/<asin> links.
export function isbn10FromIsbn13(isbn13) {
  const clean = String(isbn13 || "").replace(/[-\s]/g, "");
  if (!/^978\d{10}$/.test(clean)) return null;
  const core = clean.slice(3, 12); // first 9 of the original ISBN-10
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += (10 - i) * Number(core[i]);
  const checkDigit = (11 - (sum % 11)) % 11;
  return core + (checkDigit === 10 ? "X" : String(checkDigit));
}

// Build an Amazon US product URL from an ISBN-13. Falls back to search if the
// ISBN-10 conversion fails (e.g. for 979-prefix titles).
export function amazonUrl(isbn13, affiliateTag) {
  const isbn10 = isbn10FromIsbn13(isbn13);
  const base = isbn10
    ? `https://www.amazon.com/dp/${isbn10}`
    : `https://www.amazon.com/s?k=${encodeURIComponent(isbn13)}`;
  return affiliateTag
    ? `${base}${base.includes("?") ? "&" : "?"}tag=${encodeURIComponent(affiliateTag)}`
    : base;
}
