const MAX_SLUG_LENGTH = 60;

/** Letters that do not split into a base letter and an accent, so NFD leaves them alone. */
const PLAIN_LETTERS: Record<string, string> = { ø: "o", æ: "ae", œ: "oe", ß: "ss", đ: "d", ð: "d", ł: "l", þ: "th" };

/**
 * The file name a doc title becomes (`docs/context/<slug>.md`): lower-case letters, digits and single hyphens, which
 * is what the backend accepts. Accents fall back to their plain letters ("Släpp" -> "slapp"); a title with nothing
 * usable gives "".
 */
export function docSlug(title: string): string {
  return title
    .toLowerCase()
    .replace(/[øæœßđðłþ]/g, letter => PLAIN_LETTERS[letter]!)
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}
