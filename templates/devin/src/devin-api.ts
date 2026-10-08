import { z } from "zod";
import type { Env } from "./env";

const REQUEST_TIMEOUT_MS = 30_000;

const OutpostSession = z.object({
  metadata: z.object({
    session_id: z.string().min(1),
    outpost_id: z.string(),
  }),
  status: z
    .object({
      session_status: z.string().nullish(),
      phase: z.string().nullish(),
    })
    .nullish(),
});

const OutpostSessionPage = z.object({
  items: z.array(OutpostSession),
  cursor: z.string().nullish(),
  has_next_page: z.boolean().nullish(),
});

export type OutpostSession = z.infer<typeof OutpostSession>;

// Lists every session for the configured outpost, following Devin's pagination cursor.
export async function listOutpostSessions(env: Env): Promise<OutpostSession[]> {
  const apiUrl = env.DEVIN_API_URL.replace(/\/$/, "");
  const outpost = encodeURIComponent(env.DEVIN_OUTPOST_ID);
  const sessions: OutpostSession[] = [];
  const seenCursors = new Set<string>();
  let cursor: string | undefined;

  for (;;) {
    const cursorQuery = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
    const response = await fetch(`${apiUrl}/outposts/devins?outpost=${outpost}${cursorQuery}`, {
      headers: { Authorization: `Bearer ${env.DEVIN_API_TOKEN}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`Devin API returned ${response.status}: ${await response.text()}`);
    }

    const page = OutpostSessionPage.parse(await response.json());
    sessions.push(...page.items);
    if (page.has_next_page !== true) return sessions;

    if (page.cursor === undefined || page.cursor === null) {
      throw new Error("Devin API omitted the next-page cursor");
    }
    if (seenCursors.has(page.cursor)) {
      throw new Error("Devin API repeated a pagination cursor");
    }
    seenCursors.add(page.cursor);
    cursor = page.cursor;
  }
}
