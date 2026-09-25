import * as z from "zod/mini";

/** How one option is checked, and what the `TypeError` says after the option's name. */
export interface OptionRule {
  readonly schema: z.ZodMiniType;
  readonly requirement: string;
}

/** One rule for every option of `T`, so an option added to the type must also be checked. */
export type OptionRules<T> = { readonly [Name in keyof Required<T>]: OptionRule };

const optionsSchema = z.object({});

// Options set to undefined are ignored, so spreading a wider options object stays valid.
export function validateOptions<Options extends object>(
  options: Options,
  rules: Readonly<Record<string, OptionRule>>,
): void {
  if (!optionsSchema.safeParse(options).success) {
    throw new TypeError("options must be an object");
  }
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!Object.hasOwn(rules, name)) {
      throw new TypeError(`unknown option "${name}"`);
    }
    const rule = rules[name];
    if (!rule.schema.safeParse(value).success) {
      throw new TypeError(`${name} ${rule.requirement}`);
    }
  }
}
