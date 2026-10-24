const QUERY = `query($account: string, $start: Time, $end: Time) {
  viewer {
    accounts(filter: {accountTag: $account}) {
      workersInvocationsAdaptive(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { requests } }
      durableObjectsInvocationsAdaptiveGroups(limit: 100, filter: {datetime_geq: $start, datetime_lt: $end}) { dimensions { type } sum { requests } }
      durableObjectsPeriodicGroups(limit: 1, filter: {datetime_geq: $start, datetime_lt: $end}) { sum { rowsRead rowsWritten duration inboundWebsocketMsgCount } }
    }
  }
}`;

export function unavailableDailyUsage(now, status = 'unavailable') {
  const day = new Date(now).toISOString().slice(0, 10);
  return {
    status, available: false, configured: status !== 'not_configured', day,
    checkedAt: null, resetsAt: Date.parse(`${day}T00:00:00.000Z`) + 24 * 60 * 60 * 1000,
    estimated: true, stale: false, metrics: null,
    failureCode: status === 'not_configured' ? 'not_configured' : 'analytics_unavailable'
  };
}

export async function collectDailyUsage(env, { now = Date.now(), fetcher = fetch, clock = () => now } = {}) {
  if (!env.CF_ACCOUNT_ID || !env.CF_ANALYTICS_TOKEN) return unavailableDailyUsage(now, 'not_configured');
  const result = unavailableDailyUsage(now);
  try {
    const response = await fetcher('https://api.cloudflare.com/client/v4/graphql', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.CF_ANALYTICS_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: QUERY, variables: { account: env.CF_ACCOUNT_ID, start: `${result.day}T00:00:00.000Z`, end: new Date(now).toISOString() } }),
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) throw new Error('analytics_unavailable');
    const body = await response.json();
    if (body.errors?.length || body.data?.viewer?.accounts?.length !== 1) throw new Error('analytics_unavailable');
    const account = body.data.viewer.accounts[0];
    const datasets = [account.workersInvocationsAdaptive, account.durableObjectsInvocationsAdaptiveGroups, account.durableObjectsPeriodicGroups];
    if (datasets.some(rows => !Array.isArray(rows))) throw new Error('analytics_unavailable');
    const sum = (rows, key, weight = () => 1) => rows.reduce((total, row) => {
      const value = row.sum?.[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) throw new Error('analytics_unavailable');
      return total + value * weight(row);
    }, 0);
    const metric = (used, limit) => ({ used, limit, level: used >= limit ? 'exceeded' : used >= limit * 0.95 ? 'critical' : used >= limit * 0.8 ? 'warning' : 'normal' });
    result.metrics = {
      workersRequests: metric(sum(datasets[0], 'requests'), 100000),
      durableRequests: metric(sum(datasets[1], 'requests', row => {
        if (typeof row.dimensions?.type !== 'string') throw new Error('analytics_unavailable');
        return row.dimensions.type === 'hibernation' ? 1 / 20 : 1;
      }) + sum(datasets[2], 'inboundWebsocketMsgCount') / 20, 100000),
      rowsRead: metric(sum(datasets[2], 'rowsRead'), 5000000),
      rowsWritten: metric(sum(datasets[2], 'rowsWritten'), 100000),
      duration: metric(sum(datasets[2], 'duration'), 13000)
    };
    const finishedAt = clock();
    if (new Date(finishedAt).toISOString().slice(0, 10) !== result.day) return unavailableDailyUsage(finishedAt);
    return { ...result, status: 'ready', available: true, checkedAt: now, failureCode: null };
  } catch {
    return unavailableDailyUsage(clock());
  }
}
