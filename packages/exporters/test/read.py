"""Reads an exported .sav or .dta back and prints what a statistician would see, as JSON."""
import json
import math
import sys

path = sys.argv[1]
out = {}
if path.endswith('.sav'):
    import pyreadstat

    df, meta = pyreadstat.read_sav(path, user_missing=True)
    out['labels'] = meta.column_names_to_labels
    out['value_labels'] = {k: {str(int(c)): l for c, l in v.items()} for k, v in meta.variable_value_labels.items()}
    # Discrete missing values come back as ranges with equal ends.
    out['missing'] = {k: [r['lo'] for r in v] for k, v in (meta.missing_ranges or {}).items()}
    out['measure'] = meta.variable_measure
else:
    import pandas as pd

    with pd.io.stata.StataReader(path) as r:
        df = r.read(convert_categoricals=False)
        out['labels'] = r.variable_labels()
        out['value_labels'] = {k: {str(c): l for c, l in v.items()} for k, v in r.value_labels().items()}
out['columns'] = list(df.columns)


def clean(v):
    if v is None:
        return None
    if isinstance(v, float):
        return None if math.isnan(v) else v
    return v


out['rows'] = [[clean(v) for v in row] for row in df.astype(object).values.tolist()]
print(json.dumps(out, ensure_ascii=False, default=str))
