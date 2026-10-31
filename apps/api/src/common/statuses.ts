/** Interviews that count as data: submitted and not (yet) rejected or sent back. */
export const COUNTED = ['submitted', 'in_review', 'approved'] as const;

/** The same list as SQL, `('submitted', 'in_review', 'approved')`, for `status in ${…}`. */
export const COUNTED_LIST = `(${COUNTED.map((s) => `'${s}'`).join(', ')})`;
