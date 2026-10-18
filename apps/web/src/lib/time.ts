export type DateGroup = 'Hoje' | 'Ontem' | 'Últimos 7 dias' | 'Últimos 30 dias' | 'Mais antigas';

const DAY = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

export function dateGroup(timestamp: number, now: number = Date.now()): DateGroup {
  const today = startOfDay(now);
  if (timestamp >= today) return 'Hoje';
  if (timestamp >= today - DAY) return 'Ontem';
  if (timestamp >= today - 7 * DAY) return 'Últimos 7 dias';
  if (timestamp >= today - 30 * DAY) return 'Últimos 30 dias';
  return 'Mais antigas';
}

export const GROUP_ORDER: readonly DateGroup[] = [
  'Hoje',
  'Ontem',
  'Últimos 7 dias',
  'Últimos 30 dias',
  'Mais antigas',
];

export function groupByDate<T>(items: readonly T[], getTime: (item: T) => number, now = Date.now()) {
  const map = new Map<DateGroup, T[]>();
  for (const item of items) {
    const g = dateGroup(getTime(item), now);
    const list = map.get(g) ?? [];
    list.push(item);
    map.set(g, list);
  }
  return GROUP_ORDER.filter((g) => map.has(g)).map((g) => ({ group: g, items: map.get(g)! }));
}
