export function StripePattern({
  size = 8,
  ...props
}: {
  size?: number;
} & React.ComponentPropsWithoutRef<'pattern'>) {
  return (
    <defs>
      <pattern
        viewBox="0 0 10 10"
        width={size}
        height={size}
        patternUnits="userSpaceOnUse"
        {...props}
      >
        <line
          x1="0"
          y1="10"
          x2="10"
          y2="0"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          className="[stroke:hsl(0,0%,0%)] dark:[stroke:hsl(0,0%,30%)]"
        />
      </pattern>
    </defs>
  );
}

export function DotPattern({
  size = 8,
  ...props
}: {
  size?: number;
} & React.ComponentPropsWithoutRef<'pattern'>) {
  return (
    <defs>
      <pattern
        viewBox="0 0 10 10"
        width={size}
        height={size}
        patternUnits="userSpaceOnUse"
        {...props}
      >
        <circle
          cx="5"
          cy="5"
          r="1"
          fill="currentColor"
          className="[fill:hsl(0,0%,0%)] dark:[fill:hsl(0,0%,30%)]"
        />
      </pattern>
    </defs>
  );
}

export function GridPattern({
  size = 16,
  ...props
}: {
  size?: number;
} & React.ComponentPropsWithoutRef<'pattern'>) {
  return (
    <defs>
      <pattern
        viewBox="0 0 10 10"
        width={size}
        height={size}
        patternUnits="userSpaceOnUse"
        {...props}
      >
        <path
          d="M0 5H10 M5 0V10"
          stroke="currentColor"
          vectorEffect="non-scaling-stroke"
          fill="none"
        />
      </pattern>
    </defs>
  );
}
