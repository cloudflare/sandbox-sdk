// Secrets declared outside wrangler.jsonc are not picked up by `wrangler types`,
// so we augment the generated Env with them here.
interface Env {
  DEVIN_API_TOKEN: string;
}
