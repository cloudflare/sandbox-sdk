import type { CSSProperties } from 'react';
import { code } from '../code-sample';
import { File } from '../components/file';
import { CodeBlock, DotBox, GridBox, StripeBox } from '../components/grid';
import { Logo } from '../logo';

export function Hero() {
  return (
    <div className="lg:grid lg:grid-cols-8 lg:border-l lg:auto-rows-fr flex flex-col lg:block">
      {/* Mobile: Simple layout */}
      <div className="lg:hidden border">
        <div className="p-6 border-b">
          <p className="font-semibold text-xl mb-3">
            Meet Cloudflare Sandboxes.
          </p>
          <p className="text-sm text-foreground/80">
            Execute commands, manage files, run services, and expose them via
            public URLs - all within secure, sandboxed containers.{' '}
            <a
              className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 whitespace-nowrap"
              href="https://developers.cloudflare.com/sandbox/"
              target="_blank"
              rel="noreferrer"
            >
              Get Started
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                width="14"
                height="14"
                aria-hidden="true"
              >
                <path
                  fill="currentColor"
                  d="M13 5a1 1 0 1 1 2 0v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H8a1 1 0 1 1 0-2h5V5Z"
                />
              </svg>
            </a>
          </p>
        </div>
        <div className="overflow-x-auto">
          <CodeBlock>{code}</CodeBlock>
        </div>
      </div>

      {/* Desktop: Description box */}
      <GridBox
        x={2}
        width={3}
        className="hidden lg:flex px-8 flex-col justify-center gap-2"
      >
        <p className="font-semibold text-xl">Meet Cloudflare Sandboxes.</p>
        <p>
          Execute commands, manage files, run services, and expose them via
          public URLs - all within secure, sandboxed containers.{' '}
          <a
            className="inline-flex items-center gap-1 text-foreground underline underline-offset-4 whitespace-nowrap"
            href="https://developers.cloudflare.com/sandbox/"
            target="_blank"
            rel="noreferrer"
          >
            Get Started
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              width="14"
              height="14"
              aria-hidden="true"
            >
              <path
                fill="currentColor"
                d="M13 5a1 1 0 1 1 2 0v5h5a1 1 0 1 1 0 2h-5v5a1 1 0 1 1-2 0v-5H8a1 1 0 1 1 0-2h5V5Z"
              />
            </svg>
          </a>
        </p>
      </GridBox>
      {/* Desktop: Logo and icons */}
      <GridBox x={5} className="hidden lg:flex items-center justify-center">
        <Logo size={100} />
      </GridBox>
      <GridBox x={6} className="hidden lg:block">
        <div className="h-full rounded-full border flex items-center justify-center p-1 bg-background">
          <div className="h-full w-full rounded-full border border-dashed flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              width="80"
            >
              <title>Sandbox</title>
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M9.81814 3.17532C10.4418 3.06617 11.1506 3.00356 11.8928 3.00015C12.635 2.99674 13.4089 3.05252 14.1547 3.17532C15.333 3.36955 16.3256 4.24376 16.3256 5.40752V9.49655C16.3256 10.6956 15.3619 11.6787 14.1547 11.6787H9.81814C8.34576 11.6787 7.10586 12.929 7.10586 14.3463V16.3083H5.6131C4.35129 16.3083 3.61426 15.4024 3.30564 14.1311C2.88933 12.4232 2.90701 11.4025 3.30564 9.76682C3.65123 8.33981 4.75611 7.58967 6.01792 7.58967H11.989V7.04414H7.64731V5.40752C7.64731 4.16832 7.98088 3.49636 9.81814 3.17532ZM10.3596 5.13725C10.3596 4.68459 9.99335 4.31645 9.54489 4.31645C9.09482 4.31645 8.73019 4.68459 8.73019 5.13725C8.73019 5.58831 9.09482 5.95306 9.54489 5.95306C9.99335 5.95306 10.3596 5.58831 10.3596 5.13725Z"
                fill="currentColor"
              />
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M16.8668 9.49643V7.58955H18.4961C19.7596 7.58955 20.3551 8.52428 20.667 9.7667C21.101 11.4923 21.1203 12.7859 20.667 14.131C20.2282 15.4376 19.7579 16.3082 18.4961 16.3082H11.9887V16.8537H16.3253V18.4903C16.3253 19.7295 15.2475 20.3594 14.1545 20.6725C12.5101 21.1444 11.1922 21.0721 9.81787 20.6725C8.67019 20.3386 7.64704 19.6541 7.64704 18.4903V14.4013C7.64704 13.2247 8.63 12.2191 9.81787 12.2191H14.1545C15.5995 12.2191 16.8668 10.9748 16.8668 9.49643ZM15.2424 18.7606C15.2424 18.3095 14.8778 17.9448 14.4277 17.9448C13.9793 17.9448 13.613 18.3095 13.613 18.7606C13.613 19.2132 13.9793 19.5814 14.4277 19.5814C14.8778 19.5814 15.2424 19.2132 15.2424 18.7606Z"
                fill="currentColor"
              />
            </svg>
          </div>
        </div>
      </GridBox>
      <GridBox x={7} y={1} className="hidden lg:block">
        <div className="h-full rounded-full border flex items-center justify-center p-1 bg-background">
          <div className="h-full w-full rounded-full border border-dashed flex items-center justify-center">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="none"
              width="80"
            >
              <title>Sandbox</title>
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M7.16146 3H16.8386C17.3657 2.99998 17.8205 2.99997 18.195 3.03057C18.5904 3.06287 18.9836 3.13419 19.362 3.32698C19.9265 3.6146 20.3854 4.07355 20.673 4.63803C20.8658 5.01641 20.9371 5.40963 20.9694 5.80498C21 6.17954 21 6.6343 21 7.16144V16.8386C21 17.3657 21 17.8205 20.9694 18.195C20.9371 18.5904 20.8658 18.9836 20.673 19.362C20.3854 19.9265 19.9265 20.3854 19.362 20.673C18.9836 20.8658 18.5904 20.9371 18.195 20.9694C17.8205 21 17.3657 21 16.8386 21H7.16144C6.6343 21 6.17954 21 5.80498 20.9694C5.40963 20.9371 5.01641 20.8658 4.63803 20.673C4.07355 20.3854 3.6146 19.9265 3.32698 19.362C3.13419 18.9836 3.06287 18.5904 3.03057 18.195C2.99997 17.8205 2.99998 17.3657 3 16.8386V7.16142C2.99998 6.6343 2.99997 6.17953 3.03057 5.80498C3.06287 5.40963 3.13419 5.01641 3.32698 4.63803C3.6146 4.07355 4.07355 3.6146 4.63803 3.32698C5.01641 3.13419 5.40963 3.06287 5.80498 3.03057C6.17953 2.99997 6.63434 2.99998 7.16146 3ZM9.55966 16.695V17.991C9.81166 18.036 10.0997 18.054 10.3967 18.054C11.7647 18.054 12.6287 17.46 12.6287 16.101V11.538H11.1257V15.876C11.1257 16.524 10.8377 16.749 10.2077 16.749C9.97366 16.749 9.81166 16.731 9.55966 16.695ZM14.0521 15.867L13.1251 16.902C13.6561 17.64 14.8261 18.099 15.8971 18.099C17.3281 18.099 18.5071 17.316 18.5071 15.966C18.5071 14.5505 17.2586 14.2854 16.2441 14.07L16.2301 14.067L16.1985 14.0601C15.3909 13.8846 14.9611 13.7912 14.9611 13.347C14.9611 12.933 15.3571 12.681 15.9241 12.681C16.6081 12.681 17.1391 13.005 17.5351 13.509L18.4441 12.519C17.9671 11.916 17.0851 11.439 15.9691 11.439C14.5921 11.439 13.4941 12.231 13.4941 13.5C13.4941 14.796 14.5381 15.111 15.4921 15.318C15.5736 15.336 15.6522 15.3529 15.7277 15.3692C16.5606 15.549 17.0221 15.6487 17.0221 16.119C17.0221 16.605 16.5811 16.857 15.9601 16.857C15.2671 16.857 14.5561 16.515 14.0521 15.867Z"
                fill="currentColor"
              />
            </svg>
          </div>
        </div>
      </GridBox>

      {/* Desktop: Main code block */}
      <GridBox x={1} y={1} height={4} width={4} className="hidden lg:block">
        <CodeBlock>{code}</CodeBlock>
      </GridBox>
      {/* Desktop: Decorative corner paths and flow elements */}
      <GridBox x={5} y={1} className="hidden lg:block">
        <CornerPath rotation={180} delay="-0.3s" reverse duration="0.9s" />
      </GridBox>
      <GridBox x={5} y={3} className="hidden lg:block">
        <CornerPath rotation={270} delay="-0.9s" duration="0.9s" reverse />
      </GridBox>
      <GridBox x={6} y={1} className="hidden lg:block">
        <CornerPath rotation={90} delay="-1.2s" duration="0.9s" />
      </GridBox>
      <GridBox className="hidden lg:block">
        <svg
          viewBox="0 0 100 100"
          width="100%"
          height="100%"
          aria-hidden="true"
        >
          <circle cx="50" cy="50" r="7" className="fill-foreground" />
          <path
            d="M 50 50 H 100"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <path
            d="M 50 50 H 100"
            fill="none"
            stroke="var(--color-orange-800)"
            strokeWidth="2"
            strokeLinecap="round"
            className="tube-path"
            style={
              {
                '--tube-delay': '0s',
                '--tube-duration': '0.7s'
              } as CSSProperties
            }
          />
          <circle cx="50" cy="50" r="4" className="fill-white" />
          <path id="circle-path" d="M 35 50 a 15 15 0 1 1 30 0" fill="none" />
          <text className="font-mono fill-foreground" fontSize="10">
            <textPath startOffset="10" textLength="26" href="#circle-path">
              start
            </textPath>
          </text>
        </svg>
      </GridBox>
      <GridBox x={1} className="hidden lg:block">
        <CornerPath rotation={180} delay="-0.7s" reverse duration="0.9s" />
      </GridBox>
      <GridBox className="hidden lg:block relative" y={4}>
        <div className="absolute size-5 rounded-full border bg-background right-0 top-1/2 translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
          <div className="size-3 rounded-full bg-foreground" />
        </div>
        <svg
          viewBox="0 0 100 100"
          width="100%"
          height="100%"
          aria-hidden="true"
        >
          <circle cx="50" cy="50" r="7" className="fill-foreground" />
          <path
            d="M 50 50 H 100"
            fill="none"
            stroke="currentColor"
            strokeWidth="4"
            strokeLinecap="round"
          />
          <path
            d="M 50 50 H 100"
            fill="none"
            stroke="var(--color-orange-800)"
            strokeWidth="2"
            strokeLinecap="round"
            className="tube-path"
            style={
              {
                '--tube-delay': '-0.4s',
                '--tube-duration': '0.7s',
                '--tube-direction': 'reverse'
              } as CSSProperties
            }
          />
          <circle cx="50" cy="50" r="4" className="fill-white" />
          <text className="font-mono fill-foreground" fontSize="10">
            <textPath startOffset="8" textLength="30" href="#circle-path">
              finish
            </textPath>
          </text>
        </svg>
      </GridBox>

      {/* Desktop: Terminal and file system visualization */}
      <GridBox x={5} y={2} width={3} className="hidden lg:block">
        <DotBox>
          <div className="relative p-8 pb-0 h-full w-full">
            <div className="relative bg-background w-full h-full border border-b-0 overflow-hidden">
              <div className="h-6 border-b" />
              <div className="font-mono p-4 space-y-1 overflow-hidden">
                <p>$ git clone https://github.com/cloudflare/agents</p>
                <p>$ npm test</p>
              </div>
            </div>
          </div>
        </DotBox>
      </GridBox>
      <GridBox x={6} y={3} width={2} height={2} className="hidden lg:block">
        <DotBox>
          <div className="flex flex-col justify-center items-center relative">
            <div
              className="tube-bar tube-bar-vertical w-2 h-8 bg-foreground rounded-t-full"
              style={
                {
                  '--tube-delay': '-0.2s',
                  '--tube-duration': '0.9s'
                } as CSSProperties
              }
            />
          </div>
          <div className="relative ml-8 border bg-background h-full w-full p-8 grid grid-cols-4">
            {Array.from({ length: 12 }).map((_, i) => {
              // biome-ignore lint/suspicious/noArrayIndexKey: it's fine
              return <File key={i} />;
            })}
          </div>
        </DotBox>
        <div className="absolute size-5 rounded-full border bg-background left-1/2 top-0 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
          <div className="size-3 rounded-full bg-foreground" />
        </div>
      </GridBox>
      <GridBox
        x={6}
        y={1}
        className="lg:[--tube-aspect:1]"
        style={{ aspectRatio: 'var(--tube-aspect, auto)' }}
      >
        <div className="h-full relative z-10">
          <div className="absolute size-5 rounded-full border bg-background left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
            <div className="size-3 rounded-full bg-foreground" />
          </div>
          <div className="absolute size-5 rounded-full border bg-background left-1/2 bottom-0 -translate-x-1/2 translate-y-1/2 flex items-center justify-center">
            <div className="size-3 rounded-full bg-foreground" />
          </div>
          <svg
            viewBox="0 0 100 100"
            aria-hidden="true"
            className="w-full h-[300px] lg:h-full"
          >
            <path
              d="M 50 0 V 100"
              fill="none"
              stroke="currentColor"
              strokeWidth="4"
              strokeLinecap="round"
            />
            <path
              d="M 50 0 V 100"
              fill="none"
              stroke="var(--color-orange-800)"
              strokeWidth="2"
              strokeLinecap="round"
              className="tube-path"
              style={
                {
                  '--tube-delay': '-0.5s',
                  '--tube-duration': '0.9s'
                } as CSSProperties
              }
            />
          </svg>
        </div>
      </GridBox>

      {/* Desktop: Decorative stripe boxes */}
      <GridBox y={1} height={3} className="hidden lg:block">
        <StripeBox />
      </GridBox>
      <GridBox x={7} className="hidden lg:block">
        <StripeBox />
      </GridBox>
      <GridBox x={5} y={4} className="hidden lg:block">
        <StripeBox />
      </GridBox>
    </div>
  );
}

function CornerPath({
  rotation = 0,
  delay = '0s',
  reverse = false,
  duration
}: {
  rotation?: 0 | 90 | 180 | 270;
  delay?: string;
  reverse?: boolean;
  duration?: string;
}) {
  const tubeStyle = {
    '--tube-delay': delay,
    '--tube-direction': reverse ? 'reverse' : 'normal',
    ...(duration ? { '--tube-duration': duration } : {})
  } as CSSProperties;

  return (
    <div
      className="h-full relative z-10"
      style={{ transform: `rotate(${rotation}deg)` }}
    >
      <div className="absolute size-5 rounded-full border border-foreground bg-background left-1/2 -translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
        <div className="size-3 rounded-full bg-foreground" />
      </div>
      <div className="absolute size-5 rounded-full border border-foreground bg-background top-1/2 right-0 translate-x-1/2 -translate-y-1/2 flex items-center justify-center">
        <div className="size-3 rounded-full bg-foreground" />
      </div>
      <svg viewBox="0 0 100 100" width="100%" height="100%" aria-hidden="true">
        <path
          d="M 50 0 v 30 a 20 20 0 0 0 20 20 h 30"
          fill="none"
          stroke="currentColor"
          strokeWidth="4"
          strokeLinecap="round"
        />
        <path
          d="M 50 0 v 30 a 20 20 0 0 0 20 20 h 30"
          fill="none"
          stroke="var(--color-orange-800)"
          strokeWidth="2"
          strokeLinecap="round"
          className="tube-path"
          style={tubeStyle}
        />
      </svg>
    </div>
  );
}
