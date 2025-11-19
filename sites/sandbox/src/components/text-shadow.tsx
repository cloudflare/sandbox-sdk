import type { ComponentPropsWithoutRef, CSSProperties } from 'react';

function TextStroke({ style, ...props }: ComponentPropsWithoutRef<'span'>) {
  return (
    <span
      style={{
        ...style,
        WebkitTextStroke: '1px var(--foreground)',
        color: 'var(--background)'
      }}
      {...props}
    />
  );
}

export function TextShadow({
  text,
  count,
  gap = '-0.7em'
}: {
  text: string;
  count: number;
  gap?: string;
}) {
  return (
    <span
      className="flex flex-col leading-[0.8] space-y-[var(--gap)]"
      style={
        {
          '--gap': gap
        } as CSSProperties
      }
    >
      {Array.from({ length: count }).map((_, index) => (
        <TextStroke
          // biome-ignore lint/suspicious/noArrayIndexKey: <explanation>
          key={index}
          className="select-none"
        >
          {text}
        </TextStroke>
      ))}
      <span>{text}</span>
    </span>
  );
}
