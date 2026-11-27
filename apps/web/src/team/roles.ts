/** Pure rules of the people page: which role rows add nothing, and who matches the filters. */

export interface Grant {
  role: string;
  projectId: string | null;
}

/** Where `outer` applies, `inner` does too: the whole organisation covers every project. */
const covers = (outer: Grant, inner: Grant) =>
  outer.projectId === null || outer.projectId === inner.projectId;

const within = (a: readonly string[], b: readonly string[]) => a.every((p) => b.includes(p));

/**
 * For each row, the index of another row that already gives everything it gives where it
 * applies (rows add up, so such a row changes nothing), or null. `permissions` is what each
 * role may do in this organisation; while it is unknown nothing is flagged. Of two rows that
 * cover each other, only the later one is flagged.
 */
export function redundantRows(
  grants: readonly Grant[],
  permissions: Readonly<Record<string, readonly string[]>> | undefined,
): (number | null)[] {
  if (!permissions) return grants.map(() => null);
  const coveredBy = (i: number, j: number) => {
    if (j === i) return false;
    const mine = permissions[grants[i]!.role];
    const theirs = permissions[grants[j]!.role];
    if (!mine || !theirs || !covers(grants[j]!, grants[i]!) || !within(mine, theirs)) return false;
    // Mutual cover (the same row twice, or roles equal here): the earlier one stays.
    const mutual = covers(grants[i]!, grants[j]!) && within(theirs, mine);
    return !mutual || j < i;
  };
  const flagged = grants.map((_, i) => grants.some((_, j) => coveredBy(i, j)));
  // Name a row that stays (one not itself flagged) when there is one.
  return grants.map((_, i) => {
    if (!flagged[i]) return null;
    const by = grants.findIndex((_, j) => !flagged[j] && coveredBy(i, j));
    return by !== -1 ? by : grants.findIndex((_, j) => coveredBy(i, j));
  });
}

/**
 * The role and project filters: some row of the person has that role (any, when empty) and
 * reaches that project (any, when empty); a role for the whole organisation reaches all.
 */
export function matchesGrants(grants: readonly Grant[], role: string, projectId: string): boolean {
  if (!role && !projectId) return true;
  return grants.some(
    (g) =>
      (!role || g.role === role) &&
      (!projectId || g.projectId === null || g.projectId === projectId),
  );
}
