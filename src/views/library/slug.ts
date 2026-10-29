const MAX_SLUG_LENGTH = 60;

/**
 * The file name a doc title becomes (`docs/context/<slug>.md`): lower-case letters, digits and single hyphens, which
 * is what the backend accepts. Accents fall back to their plain letters ("Släpp" -> "slapp"); a title with nothing
 * usable gives "".
 */
export function docSlug(title: string): string {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_SLUG_LENGTH)
    .replace(/-+$/g, "");
}
