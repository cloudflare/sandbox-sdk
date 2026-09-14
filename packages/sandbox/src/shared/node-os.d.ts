declare module "node:os" {
  export const constants: {
    readonly errno: Readonly<Record<string, number>>;
  };
}
