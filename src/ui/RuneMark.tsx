/** Riggverk's rune mark (the app icon's glyph), drawn in the current text colour. Decorative: always paired with the visible name. */
export function RuneMark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 64 64" width="16" height="16" aria-hidden="true" focusable="false">
      <path
        fill="currentColor"
        fillRule="evenodd"
        d="M51.22 22.91 L33 7.6 L33 5.33 L31 3.33 L29 5.33 L29 7.6 L17 17.68 L17 15.51 L13 11.94 L13 52.72 L29 39.82 L29 58.66 L31 60.66 L33 58.66 L33 39.82 L51 54.34 L51 49.2 L35.15 36.41Z M26.85 36.41 L17 44.36 L17 28.13Z M45 22.91 L33 32.99 L33 12.82Z M17 22.91 L29 12.82 L29 32.99Z"
      />
    </svg>
  );
}
