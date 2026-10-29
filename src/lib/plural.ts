/** "1 file", "2 files": a count with its noun, regular plural only. */
export function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}
