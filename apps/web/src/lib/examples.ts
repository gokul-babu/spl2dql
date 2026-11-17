/** Five real-world searches of increasing difficulty for the example menu. */
export const EXAMPLES: readonly { title: string; spl: string }[] = [
  { title: 'Errors per host', spl: 'index=web level=ERROR earliest=-24h@h\n| stats count by host\n| sort -count\n| head 10' },
  { title: 'Slow requests over time', spl: 'index=web uri="/api/*" duration>2000\n| timechart span=5m count by method' },
  {
    title: 'Extract a field and rank it',
    spl: 'index=web "login failed"\n| rex field=_raw "user=(?<username>\\w+)"\n| stats count by username\n| where count > 5\n| sort -count',
  },
  {
    title: 'Enrich with a lookup',
    spl: 'index=web status>=500\n| lookup http_status code AS status OUTPUT description\n| eval kb=round(bytes/1024, 1)\n| table _time, host, status, description, kb',
  },
  {
    title: 'Sessions and geography',
    spl: 'index=web\n| transaction session maxpause=10m\n| iplocation clientip\n| stats avg(duration) as avg_duration by Country',
  },
];
