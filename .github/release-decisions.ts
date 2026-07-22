export type Decision<TMatching, TConflict> =
  | { readonly state: 'missing' }
  | { readonly state: 'matching'; readonly observed: TMatching }
  | { readonly state: 'conflict'; readonly conflict: TConflict };

export interface DecisionSummary {
  missing: string[];
  matching: string[];
  conflicts: string[];
}

export function createDecisionSummary(
  decisions: Record<string, Decision<unknown, string>>
): DecisionSummary {
  const missing: string[] = [];
  const matching: string[] = [];
  const conflicts: string[] = [];
  for (const name of Object.keys(decisions).sort()) {
    const decision = decisions[name];
    if (decision.state === 'missing') missing.push(name);
    if (decision.state === 'matching') matching.push(name);
    if (decision.state === 'conflict') {
      conflicts.push(`${name}: ${decision.conflict}`);
    }
  }
  return { missing, matching, conflicts };
}
