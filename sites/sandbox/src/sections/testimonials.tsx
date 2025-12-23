/** biome-ignore-all lint/suspicious/noArrayIndexKey: it's fine */
import { DotBox, GridBox, StripeBox } from '../components/grid';
import { TextShadow } from '../components/text-shadow';

interface Testimonial {
  quote: string;
  author: string;
  role: string;
  company: string;
  logo?: string;
}

const testimonials: Testimonial[] = [
  {
    quote:
      "The sandbox SDK is a core part of our infrastructure at Iterate. It's made giving our agents a 'computer' really easy to do, saving us weeks of effort. The team has been very responsive and helpful when dealing with us throughout the implementation process.",
    author: 'Nick Blow',
    role: 'Founding Engineer',
    company: 'Iterate'
  },
  {
    quote:
      'The developer experience is well-thought-out and built on layers of nice abstractions you can override as needed.',
    author: 'Seve Ibarluzea',
    role: 'Co-Founder',
    company: 'tscircuit.com'
  },
  {
    quote:
      'Sandbox SDK let us to remove ~12k lines of orchestration code and significantly improved our sandbox startup times. The APIs + docs are best-in-class and their team has been an absolute joy to work with.',
    author: 'Dominic Whyte',
    role: 'Co-Founder',
    company: 'Zite'
  }
];

export function Testimonials() {
  return (
    <div className="lg:grid lg:grid-cols-8 lg:border-l lg:auto-rows-fr flex flex-col lg:block">
      {/* Desktop decorative grid cells */}
      {Array.from({ length: 26 }).map((_, index) => (
        <div
          key={index}
          className="hidden lg:block border-r border-b aspect-square"
        />
      ))}

      {/* Mobile: Section title */}
      <div className="lg:hidden border p-6 flex items-center justify-center">
        <h2 className="text-6xl sm:text-7xl font-medium">
          <TextShadow text="Testimonials" count={3} gap="-0.6em" />
        </h2>
      </div>

      {/* Desktop: Large title */}
      <GridBox
        x={2}
        width={4}
        className="hidden lg:flex overflow-hidden items-end justify-center"
      >
        <p className="text-[120px] font-medium translate-y-2">
          <TextShadow text="Testimonials" count={5} gap="-0.6em" />
        </p>
      </GridBox>

      {/* Testimonial 1 */}
      <div className="lg:hidden border border-t-0">
        <TestimonialMobile testimonial={testimonials[0]} />
      </div>

      <GridBox x={1} y={1} width={3} height={2} className="hidden lg:flex">
        <TestimonialCard
          testimonial={testimonials[0]}
          size="sm"
          scrollable={false}
        />
      </GridBox>

      <GridBox x={4} y={1} height={2} className="hidden lg:block">
        <DotBox>
          <div className="relative h-full w-full flex items-center justify-center">
            <div className="border bg-background rounded-full size-24 flex items-center justify-center">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                width="48"
              >
                <title>Testimonial</title>
                <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
              </svg>
            </div>
          </div>
        </DotBox>
      </GridBox>

      {/* Testimonial 2 */}
      <div className="lg:hidden border border-t-0">
        <TestimonialMobile testimonial={testimonials[1]} />
      </div>

      <GridBox x={4} y={3} width={3} height={2} className="hidden lg:flex">
        <TestimonialCard testimonial={testimonials[1]} size="md" />
      </GridBox>

      <GridBox x={1} y={3} height={2} className="hidden lg:block">
        <StripeBox />
      </GridBox>

      {/* Testimonial 3 */}
      <div className="lg:hidden border border-t-0">
        <TestimonialMobile testimonial={testimonials[2]} />
      </div>

      <GridBox x={1} y={5} width={3} height={2} className="hidden lg:flex">
        <TestimonialCard
          testimonial={testimonials[2]}
          size="md"
          scrollable={false}
        />
      </GridBox>

      <GridBox x={4} y={5} height={2} className="hidden lg:block">
        <div className="h-full relative flex items-center justify-center">
          <div className="absolute size-5 rounded-full border bg-background flex items-center justify-center">
            <div className="size-3 rounded-full bg-foreground" />
          </div>
          <svg
            viewBox="0 0 100 100"
            width="100%"
            height="100%"
            aria-hidden="true"
          >
            <circle cx="50" cy="50" r="7" className="fill-foreground" />
            <circle cx="50" cy="50" r="4" className="fill-white" />
          </svg>
        </div>
      </GridBox>

      {/* Testimonial 4 */}
      {/**
      <div className="lg:hidden border border-t-0">
        <TestimonialMobile testimonial={testimonials[3]} />
      </div>
      
      <GridBox x={4} y={7} width={3} height={2} className="hidden lg:flex">
        <TestimonialCard testimonial={testimonials[3]} />
      </GridBox>
      
      */}
      <GridBox x={7} y={5} height={2} className="hidden lg:block">
        <StripeBox />
      </GridBox>
    </div>
  );
}

function TestimonialCard({
  testimonial,
  size,
  scrollable = true
}: {
  testimonial: Testimonial;
  size?: 'xl' | 'md' | 'sm';
  scrollable?: boolean;
}) {
  const textSize =
    size === 'sm' ? 'text-lg' : size === 'md' ? 'text-xl' : 'text-2xl';
  const minH = scrollable ? 'min-h-0' : '';
  const padding = scrollable ? 'p-8 pb-0' : 'p-6 pb-0';
  const innerPadding = scrollable ? 'p-6' : 'p-4';
  const gap = scrollable ? 'gap-6' : 'gap-4';
  return (
    <DotBox>
      <div
        className={`relative ${padding} h-full w-full flex flex-col ${minH}`}
      >
        <div
          className={`relative bg-background w-full border border-b-0 ${innerPadding} flex flex-col flex-1 ${gap} ${minH}`}
        >
          <div className={`flex flex-col flex-1 ${minH}`}>
            <div className="mb-2 flex items-center justify-between">
              <svg
                xmlns="http://www.w3.org/2000/svg"
                viewBox="0 0 24 24"
                fill="currentColor"
                width="24"
                className="opacity-30"
              >
                <title>Testimonial</title>
                <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
              </svg>
            </div>
            <div
              className={`flex-1 ${minH} ${scrollable ? 'overflow-y-auto pr-1' : ''}`}
            >
              <p className={`${textSize} leading-relaxed`}>
                {testimonial.quote}
              </p>
            </div>
          </div>
          <div className="border-t pt-3">
            <p className="font-semibold text-base">{testimonial.author}</p>
            <p className="text-sm text-foreground/60 font-mono">
              {testimonial.role} · {testimonial.company}
            </p>
          </div>
        </div>
      </div>
    </DotBox>
  );
}

function TestimonialMobile({ testimonial }: { testimonial: Testimonial }) {
  return (
    <div className="p-6 space-y-4">
      <div>
        <div className="flex items-center justify-between mb-3">
          <svg
            xmlns="http://www.w3.org/2000/svg"
            viewBox="0 0 24 24"
            fill="currentColor"
            width="24"
            className="opacity-30"
          >
            <title>Testimonial</title>
            <path d="M14.017 21v-7.391c0-5.704 3.731-9.57 8.983-10.609l.995 2.151c-2.432.917-3.995 3.638-3.995 5.849h4v10h-9.983zm-14.017 0v-7.391c0-5.704 3.748-9.57 9-10.609l.996 2.151c-2.433.917-3.996 3.638-3.996 5.849h3.983v10h-9.983z" />
          </svg>
        </div>
        <p className="text-base leading-relaxed text-foreground/90">
          {testimonial.quote}
        </p>
      </div>
      <div className="border-t pt-4">
        <p className="font-semibold text-base">{testimonial.author}</p>
        <p className="text-sm text-foreground/60 font-mono">
          {testimonial.role} · {testimonial.company}
        </p>
      </div>
    </div>
  );
}
