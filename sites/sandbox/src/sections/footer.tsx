/** biome-ignore-all lint/suspicious/noArrayIndexKey: it's fine */
import { useState } from 'react';
import { GridBox } from '../components/grid';

export function Footer() {
  const [copied, setCopied] = useState(false);
  const installCommand = 'npm i @cloudflare/sandbox';

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(installCommand);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <div className="lg:grid lg:grid-cols-8 lg:border-l lg:auto-rows-fr flex flex-col lg:block">
      {/* Desktop decorative grid cells */}
      {Array.from({ length: 8 }).map((_, index) => (
        <div
          key={index}
          className="hidden lg:block border-r border-b aspect-square"
        />
      ))}

      {/* Mobile: CTA buttons */}
      <div className="lg:hidden border p-6 space-y-4">
        <a
          href="https://developers.cloudflare.com/sandbox"
          target="_blank"
          rel="noopener noreferrer"
          className="block text-center text-2xl sm:text-3xl md:text-4xl font-medium border rounded-full py-4 sm:py-6 hover:bg-foreground hover:text-background transition-colors"
        >
          Get Started ↗
        </a>
        <button
          type="button"
          onClick={handleCopy}
          className="w-full text-center font-mono text-base sm:text-lg md:text-xl border rounded-full py-4 sm:py-6 hover:bg-foreground hover:text-background transition-colors cursor-pointer"
        >
          {copied ? 'Copied!' : installCommand}
        </button>
      </div>

      {/* Desktop: CTA buttons */}
      <GridBox x={1} width={4} className="hidden lg:block">
        <a
          href="https://developers.cloudflare.com/sandbox"
          target="_blank"
          rel="noopener noreferrer"
          className="text-6xl flex items-center justify-center h-[calc(100%+2px)] border rounded-full -my-px hover:bg-foreground hover:text-background transition-colors"
        >
          Get Started ↗
        </a>
      </GridBox>
      <GridBox x={3} y={1} width={4} className="hidden lg:block">
        <button
          type="button"
          onClick={handleCopy}
          className="font-mono text-3xl flex items-center justify-center h-[calc(100%+2px)] border rounded-full -my-px hover:bg-foreground hover:text-background transition-colors cursor-pointer w-full"
        >
          {copied ? 'Copied!' : installCommand}
        </button>
      </GridBox>
    </div>
  );
}
