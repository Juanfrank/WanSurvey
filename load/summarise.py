"""Summary of a sample.sh CSV: peak and mean of each measure while the load ran, and how long
the worker took to empty its queue after it stopped.  python3 load/summarise.py out.csv"""
import csv
import sys

rows = [{k: float(v) for k, v in r.items()} for r in csv.DictReader(open(sys.argv[1]))]
busy = [r for r in rows if r["api_cpu"] > 5] or rows
cols = ["api_cpu", "api_rss_mb", "worker_cpu", "worker_rss_mb", "pg_conns", "pg_active", "queue_wait", "queue_delayed"]
for c in cols:
    vals = [r[c] for r in busy]
    print(f"{c:14} mean {sum(vals) / len(vals):8.1f}   peak {max(vals):8.1f}")
end = max(r["t"] for r in busy)
after = [r for r in rows if r["t"] > end]
drained = next((r["t"] - end for r in after if r["queue_wait"] == 0 and r["queue_delayed"] == 0), None)
print(f"{'queue drained':14} {drained if drained is not None else 'not within the sample'} s after the load")
print(f"{'submitted':14} {rows[-1]['submitted'] - rows[0]['submitted']:.0f} interviews")
