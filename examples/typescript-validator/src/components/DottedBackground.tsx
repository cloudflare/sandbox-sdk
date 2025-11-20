/**
 * Cloudflare-style dotted background pattern
 * 12px spacing with 0.75px radius dots
 */
export default function DottedBackground() {
  return (
    <svg
      className="absolute inset-0 w-full h-full pointer-events-none z-0"
      aria-hidden="true"
    >
      <defs>
        <pattern
          id="dots-pattern"
          x="0"
          y="0"
          width="12"
          height="12"
          patternUnits="userSpaceOnUse"
        >
          <circle cx="6" cy="6" r="0.75" fill="#e9d1bb" />
        </pattern>
      </defs>
      <rect width="100%" height="100%" fill="url(#dots-pattern)" />
    </svg>
  );
}
