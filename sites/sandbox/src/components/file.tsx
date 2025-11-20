export function File() {
  return (
    <div className="w-12 h-14 border relative flex justify-end">
      <div className="size-5 border-t border-r border-background -mr-px -mt-px">
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 20 20"
          className="border-b border-l"
          aria-hidden="true"
        >
          <line
            x2="20"
            y2="20"
            fill="none"
            stroke="currentColor"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
      </div>
    </div>
  );
}
