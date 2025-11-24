import clsx from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { TextShadow } from './components/text-shadow';
import { Examples } from './sections/example';
import { Features } from './sections/features';
import { Footer } from './sections/footer';
import { Hero } from './sections/hero';
import { Testimonials } from './sections/testimonials';

function App() {
  // Load fonts and set CSS variables
  useEffect(() => {
    // Set font CSS variables
    document.documentElement.style.setProperty(
      '--font-sans',
      'Inter, system-ui, sans-serif'
    );
    document.documentElement.style.setProperty(
      '--font-mono',
      'IBM Plex Mono, monospace'
    );

    // Add font classes to body
    document.body.className = 'antialiased bg-background font-sans';
  }, []);

  return (
    <div className="min-h-screen">
      <GridLine className="left-6 hidden lg:flex" />
      <GridLine className="right-6 hidden lg:flex" />
      <div className="px-4 sm:px-8 lg:px-16">
        <main className="pt-4 pb-6 max-w-[1400px] mx-auto lg:border-x border-dashed">
          <h1 className="title mx-auto w-fit font-medium relative z-30 text-[70px] sm:text-[120px] md:text-[160px] lg:text-[260px] leading-none">
            <TextShadow text="sandbox" count={10} />
          </h1>
          <div className="h-6 bg-background sticky top-0 z-20 -mt-6 sm:-mt-10 lg:-mt-14" />
          <div className="w-full lg:w-[calc(100%+2px)] lg:-mx-px">
            <Header />
            <Hero />
            <Divider />
            <Features />
            <Divider />
            <Examples />
            <Divider />
            <Testimonials />
            <Divider />
            <Footer />
          </div>
        </main>
      </div>
    </div>
  );
}

// ---

function Header() {
  const command = 'npm i @cloudflare/sandbox';
  const [copied, setCopied] = useState(false);
  const resetTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(command);

      setCopied(true);

      if (resetTimer.current !== null) {
        window.clearTimeout(resetTimer.current);
      }

      resetTimer.current = window.setTimeout(() => {
        setCopied(false);
      }, 2000);
    } catch (error) {
      console.error('Failed to copy install command', error);
      setCopied(false);
    }
  };

  return (
    <header className="border flex justify-between items-center pr-2 sm:pr-4 h-10 sm:h-12 bg-background sticky top-6 z-30">
      <div className="size-10 sm:size-12 border-r grid grid-cols-2 grid-rows-2 gap-1 p-1.5 sm:p-2">
        <div className="border" />
        <div className="border" />
        <div className="border" />
        <div className="border" />
      </div>
      <div className="flex items-center gap-2 sm:gap-3">
        <button
          type="button"
          onClick={handleCopy}
          className="font-mono text-xs sm:text-sm md:text-base inline-flex items-center gap-2 px-3 py-1 rounded border border-transparent bg-background transition-colors hover:border-foreground/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
          title="Copy install command"
          aria-label={
            copied ? 'Install command copied' : 'Copy install command'
          }
        >
          {/** biome-ignore lint/a11y/useSemanticElements: aria-live is used for screen readers */}
          <span aria-live="polite" role="status">
            {copied ? 'Copied!' : command}
          </span>
          <span className="uppercase tracking-wide text-[10px] text-foreground/60">
            {copied ? 'done' : 'copy'}
          </span>
        </button>
        <a
          href="https://github.com/cloudflare/sandbox-sdk"
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center justify-center size-8 sm:size-9 rounded border border-transparent text-foreground/70 hover:text-foreground hover:border-foreground/40 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-foreground/40"
          aria-label="Open cloudflare/sandbox-sdk on GitHub"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            width="18"
            height="18"
            fill="currentColor"
          >
            <title>GitHub</title>
            <path d="M12 0.2975C5.3725 0.2975 0 5.67 0 12.2975C0 17.5825 3.43875 22.0225 8.2075 23.6825C8.8075 23.7975 9.03 23.4225 9.03 23.0975C9.03 22.8075 9.02 22.0725 9.015 21.0725C5.6725 21.7975 4.9675 19.2225 4.9675 19.2225C4.4225 17.8325 3.6325 17.4525 3.6325 17.4525C2.5475 16.7125 3.715 16.7275 3.715 16.7275C4.915 16.8175 5.5475 17.9725 5.5475 17.9725C6.615 19.7975 8.355 19.2725 9.03 18.9575C9.14 18.1775 9.455 17.6425 9.8075 17.3375C7.1475 17.0325 4.3475 16.0075 4.3475 11.4025C4.3475 10.0975 4.8075 9.0325 5.5825 8.1975C5.455 7.8925 5.0575 6.6575 5.7025 4.9975C5.7025 4.9975 6.7075 4.6775 8.9975 6.2275C9.9475 5.9625 10.9625 5.83 11.9775 5.825C12.9925 5.83 14.0075 5.9625 14.9575 6.2275C17.2475 4.6775 18.2525 4.9975 18.2525 4.9975C18.8975 6.6575 18.5 7.8925 18.3725 8.1975C19.1475 9.0325 19.6075 10.0975 19.6075 11.4025C19.6075 16.0225 16.8025 17.0275 14.1375 17.3275C14.57 17.7025 14.9575 18.4325 14.9575 19.5425C14.9575 21.0825 14.9425 22.5575 14.9425 23.0975C14.9425 23.4225 15.1625 23.8025 15.7725 23.6775C20.5463 22.015 24 17.5775 24 12.2975C24 5.67 18.6275 0.2975 12 0.2975Z" />
          </svg>
        </a>
      </div>
    </header>
  );
}

function Divider() {
  return (
    <div className="h-4 sm:h-6 border border-t-0 relative bg-neutral-200" />
  );
}

const LINES = 7;

function GridLine({ className }: { className?: string }) {
  return (
    <div
      className={clsx(
        'fixed top-6 bottom-6 flex flex-col items-center justify-between',
        className
      )}
    >
      <div className="top-0 bottom-0 absolute border-r border-current" />
      {Array.from({ length: LINES }).map((_, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
        <div key={index} className="border-t w-3" />
      ))}
    </div>
  );
}

export default App;
