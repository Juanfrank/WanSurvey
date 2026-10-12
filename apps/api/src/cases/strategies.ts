import { compileRule, type CaseLike } from './case-logic.js';

/** An active entry of the `assignments` table, as a strategy sees it. */
export interface StrategyRule {
  id: string;
  kind: string;
  userId: string;
  filter: string | null;
  quota: number | null;
  createdAt: Date;
}

/** An unassigned fresh case, in hand-out order (priority first). */
export interface PoolCase extends CaseLike {
  id: string;
}

/** Cases one rule hands to its person. */
export interface Hand {
  ruleId: string;
  userId: string;
  caseIds: string[];
}

export interface PlanInput {
  rules: StrategyRule[];
  pool: PoolCase[];
  /** Cases each person already holds in the project; updated as cases are handed out. */
  held: Map<string, number>;
  /** Cases already handed out in this run; updated as cases are handed out. */
  taken: Set<string>;
}

/**
 * A way of handing out unassigned cases, selected by `assignments.kind`. Strategies only plan;
 * the service checks who may receive cases, writes the assignments and records the events.
 */
export interface AssignmentStrategy {
  readonly kind: string;
  plan(input: PlanInput): Hand[];
}

/**
 * `rule`: rules run oldest first. Each takes the cases its filter matches, in pool order, that
 * no earlier rule took, until its person holds `quota` cases.
 */
export const ruleStrategy: AssignmentStrategy = {
  kind: 'rule',
  plan({ rules, pool, held, taken }) {
    const hands: Hand[] = [];
    const ordered = [...rules].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    for (const rule of ordered) {
      const match = compileRule(rule.filter);
      const room =
        rule.quota === null ? Infinity : Math.max(0, rule.quota - (held.get(rule.userId) ?? 0));
      const caseIds: string[] = [];
      for (const c of pool) {
        if (caseIds.length >= room) break;
        if (!taken.has(c.id) && match(c)) caseIds.push(c.id);
      }
      if (!caseIds.length) continue;
      caseIds.forEach((id) => taken.add(id));
      held.set(rule.userId, (held.get(rule.userId) ?? 0) + caseIds.length);
      hands.push({ ruleId: rule.id, userId: rule.userId, caseIds });
    }
    return hands;
  },
};

/** Registered strategies, run in this order. New kinds are added here. */
export const STRATEGIES: readonly AssignmentStrategy[] = [ruleStrategy];
