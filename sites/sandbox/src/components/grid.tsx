import clsx from 'clsx';
import {
  type ComponentPropsWithoutRef,
  type CSSProperties,
  type ReactNode,
  useId,
  useState
} from 'react';
import { DotPattern, StripePattern } from '../stripe-pattern';

type CoordinateProps = {
  x?: number;
  y?: number;
  height?: number;
  width?: number;
};

export function GridBox({
  x = 0,
  y = 0,
  height = 1,
  width = 1,
  style,
  className,
  ...props
}: CoordinateProps & ComponentPropsWithoutRef<'div'>) {
  return (
    <div
      className={clsx(
        'col-start-[var(--x)] row-start-[var(--y)] border-r border-b border-foreground relative col-span-[var(--width)] row-span-[var(--height)]',
        className
      )}
      style={
        {
          '--x': x + 1,
          '--y': y + 1,
          '--width': width,
          '--height': height,
          aspectRatio: width / height,
          ...style
        } as CSSProperties
      }
      {...props}
    />
  );
}

export function CodeBlock({ children }: { children: string }) {
  const [copied, setCopied] = useState(false);

  const extractPlainText = (html: string): string => {
    // Create a temporary element to parse the HTML
    const temp = document.createElement('div');
    temp.innerHTML = html;
    return temp.textContent || temp.innerText || '';
  };

  const handleCopy = async () => {
    try {
      const plainText = extractPlainText(children);
      await navigator.clipboard.writeText(plainText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="p-2 sm:p-4 relative h-full min-h-[300px] lg:min-h-0 group">
      <div className="absolute size-[17px] top-0 left-0 hidden lg:block [stroke:hsl(0,0%,0%)] dark:[stroke:hsl(0,0%,30%)]">
        <svg width="100%" height="100%" aria-hidden="true">
          <line x2="17" y2="17" stroke="currentColor" />
        </svg>
      </div>
      <div className="absolute size-[17px] bottom-0 right-0 hidden lg:block [stroke:hsl(0,0%,0%)] dark:[stroke:hsl(0,0%,30%)]">
        <svg width="100%" height="100%" aria-hidden="true">
          <line x2="17" y2="17" stroke="currentColor" />
        </svg>
      </div>
      <div className="absolute size-[17px] bottom-0 left-0 hidden lg:block [stroke:hsl(0,0%,0%)] dark:[stroke:hsl(0,0%,30%)]">
        <svg width="100%" height="100%" aria-hidden="true">
          <line y1="17" x2="17" stroke="currentColor" />
        </svg>
      </div>
      <div className="absolute size-[17px] top-0 right-0 hidden lg:block [stroke:hsl(0,0%,0%)] dark:[stroke:hsl(0,0%,30%)]">
        <svg width="100%" height="100%" aria-hidden="true">
          <line y1="17" x2="17" stroke="currentColor" />
        </svg>
      </div>

      {/* Copy button */}
      <button
        type="button"
        onClick={handleCopy}
        className="absolute top-4 sm:top-6 right-4 sm:right-6 z-10 p-2 border bg-background hover:bg-foreground hover:text-background transition-all"
        aria-label="Copy code to clipboard"
      >
        {copied ? (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <title>Copied</title>
            <polyline points="20 6 9 17 4 12" />
          </svg>
        ) : (
          <svg
            xmlns="http://www.w3.org/2000/svg"
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <title>Copy</title>
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        )}
      </button>

      <div
        className="h-full w-full border bg-background flex items-center justify-center p-3 sm:p-4 min-w-0 min-h-0"
        // biome-ignore lint/security/noDangerouslySetInnerHtml: children is safe
        dangerouslySetInnerHTML={{ __html: children }}
        style={
          {
            '--default-mono-font-family': 'var(--font-mono)',
            '--background': 'transparent'
          } as CSSProperties
        }
      />
    </div>
  );
}

export function StripeBox() {
  const id = useId();
  return (
    <div className="relative h-full w-full [box-shadow:inset_-4px_4px_0_4px_hsl(0,0%,90%)] dark:[box-shadow:inset_-4px_4px_0_4px_hsl(0,0%,30%)]">
      <div className="absolute inset-0">
        <svg width="100%" height="100%" aria-hidden="true">
          <StripePattern id={id} />
          <rect width="100%" height="100%" fill={`url(#${id})`} />
        </svg>
      </div>
    </div>
  );
}

export function DotBox({ children }: { children: ReactNode }) {
  const id = useId();
  return (
    <div className="relative h-full w-full overflow-hidden">
      <div className="absolute inset-0">
        <svg width="100%" height="100%" aria-hidden="true">
          <DotPattern id={id} size={10} />
          <rect width="100%" height="100%" fill={`url(#${id})`} />
        </svg>
      </div>
      {children}
    </div>
  );
}
