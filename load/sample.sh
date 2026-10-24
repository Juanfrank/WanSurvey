#!/usr/bin/env bash
# Server-side measurements during a load test, one CSV line a second, until stopped:
# CPU (% of one core) and memory of the API and the worker, Postgres connections (all, and
# active), jobs waiting and delayed in the light queue, and interviews submitted so far.
#   load/sample.sh out.csv   (API_PID, WORKER_PID, DATABASE_ADMIN_URL and REDIS_DB set)
set -u
out=${1:-samples.csv}
db=${REDIS_DB:-0}
echo "t,api_cpu,api_rss_mb,worker_cpu,worker_rss_mb,pg_conns,pg_active,queue_wait,queue_delayed,submitted" >"$out"
ticks() { awk '{print $14+$15}' "/proc/$1/stat"; }
hz=$(getconf CLK_TCK)
a0=$(ticks "$API_PID"); w0=$(ticks "$WORKER_PID")
while sleep 1; do
  a1=$(ticks "$API_PID") || exit 0
  w1=$(ticks "$WORKER_PID") || exit 0
  acpu=$(( (a1 - a0) * 100 / hz )); wcpu=$(( (w1 - w0) * 100 / hz ))
  a0=$a1; w0=$w1
  arss=$(( $(awk '/VmRSS/{print $2}' "/proc/$API_PID/status") / 1024 ))
  wrss=$(( $(awk '/VmRSS/{print $2}' "/proc/$WORKER_PID/status") / 1024 ))
  pg=$(psql "$DATABASE_ADMIN_URL" -Atc "select count(*), count(*) filter (where state = 'active') from pg_stat_activity where usename = 'wansurvey_app'" | tr '|' ',')
  wait=$(redis-cli -n "$db" llen bull:wansurvey:wait)
  # Delayed jobs other than the schedules (repeat:*), which always wait there.
  delayed=$(redis-cli -n "$db" zrange bull:wansurvey:delayed 0 -1 | grep -vc "^repeat:")
  sub=$(psql "$DATABASE_ADMIN_URL" -Atc "select count(*) from interviews where submitted_at is not null")
  echo "$(date +%s),$acpu,$arss,$wcpu,$wrss,$pg,$wait,$delayed,$sub" >>"$out"
done
