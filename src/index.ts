interface McpToolDefinition {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface McpToolExport {
  tools: McpToolDefinition[];
  callTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  meter?: { credits: number };
  cost?: Record<string, unknown>;
  provider?: string;
}

/**
 * Madrid Events MCP.
 *
 * Cultural events & activities in Madrid, Spain for the next ~100 days, from the
 * city's open-data portal (datos.madrid.es). Keyless JSON feed (~870 events),
 * filtered/normalized in-pack by keyword, free admission and date window. Rich
 * per-event data: venue, address, geo, audience, price. Content is in Spanish.
 */


const FEED = 'https://datos.madrid.es/egob/catalogo/206974-0-agenda-eventos-culturales-100.json';
const UA = 'pipeworx-mcp-madrid-events/1.0 (+https://pipeworx.io)';
const MAX_LIMIT = 50;

const tools: McpToolExport['tools'] = [
  {
    name: 'events',
    description:
      'Find cultural events & activities in Madrid, Spain (next ~100 days). Filter by keyword, free admission, and date window. Returns events with venue, address, geo, audience and price. Content is in Spanish.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Keyword over title, description and venue, e.g. "música", "exposición", "teatro".' },
        free_only: { type: 'boolean', description: 'If true, only free events.' },
        from: { type: 'string', description: 'Include events on/after this date YYYY-MM-DD (default: today).' },
        to: { type: 'string', description: 'Include events starting on/before this date YYYY-MM-DD.' },
        limit: { type: 'number', description: `Max events (1-${MAX_LIMIT}, default 20).` },
        offset: { type: 'number', description: 'Pagination offset (default 0).' },
      },
    },
  },
];

async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  if (name !== 'events') throw new Error(`Unknown tool: ${name}`);

  const res = await fetch(FEED, { headers: { Accept: 'application/json', 'User-Agent': UA } });
  if (!res.ok) throw new Error(`Madrid events: HTTP ${res.status}`);
  const all = ((await res.json()) as { '@graph'?: MadridEvent[] })['@graph'] ?? [];

  const from = dateArg(args.from) || todayISO();
  const to = dateArg(args.to);
  const q = typeof args.query === 'string' ? args.query.trim().toLowerCase() : '';
  const freeOnly = args.free_only === true;
  const limit = clamp(numArg(args.limit, 20), 1, MAX_LIMIT);
  const offset = Math.max(0, numArg(args.offset, 0));

  let out = all.filter((e) => {
    const start = dpart(e.dtstart);
    const end = dpart(e.dtend) || start;
    if (end && end < from) return false;
    if (to && start && start > to) return false;
    if (freeOnly && !isFree(e)) return false;
    if (q) {
      const hay = `${e.title} ${e.description} ${e['event-location']} ${e.audience}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  });
  out.sort((a, b) => (dpart(a.dtstart) || '9999').localeCompare(dpart(b.dtstart) || '9999'));

  return {
    city: 'Madrid',
    country: 'Spain',
    source: 'datos.madrid.es',
    date_from: from,
    date_to: to || null,
    total_matching: out.length,
    count: Math.min(Math.max(0, out.length - offset), limit),
    events: out.slice(offset, offset + limit).map(normalize),
  };
}

interface MadridAddress { area?: { locality?: string; 'postal-code'?: string; 'street-address'?: string }; district?: { '@id'?: string } }
interface MadridEvent {
  id?: string | number;
  title?: string;
  description?: string;
  free?: string | number | boolean;
  price?: string;
  dtstart?: string;
  dtend?: string;
  time?: string;
  audience?: string;
  link?: string;
  'event-location'?: string;
  address?: MadridAddress;
  location?: { latitude?: number; longitude?: number };
  organization?: { 'organization-name'?: string };
}

function normalize(e: MadridEvent): Record<string, unknown> {
  const a = e.address?.area;
  const free = isFree(e);
  return {
    id: e.id,
    title: e.title,
    url: e.link,
    summary: e.description ? e.description.replace(/\s+/g, ' ').trim().slice(0, 600) : undefined,
    date_start: dpart(e.dtstart) || undefined,
    date_end: dpart(e.dtend) && dpart(e.dtend) !== dpart(e.dtstart) ? dpart(e.dtend) : undefined,
    time: e.time || undefined,
    is_free: free,
    price: free ? undefined : e.price?.trim() || undefined,
    audience: e.audience || undefined,
    venue: {
      name: e['event-location'] || e.organization?.['organization-name'] || undefined,
      address: [a?.['street-address'], a?.['postal-code'], a?.locality].filter((p) => p && String(p).trim()).join(', ') || undefined,
      district: district(e.address?.district?.['@id']),
      latitude: e.location?.latitude,
      longitude: e.location?.longitude,
    },
  };
}

function isFree(e: MadridEvent): boolean {
  return e.free === 1 || e.free === '1' || e.free === true;
}
/** Pull the district name from its @id URL (…/Distrito/Hortaleza). */
function district(id?: string): string | undefined {
  if (!id) return undefined;
  const m = id.match(/\/Distrito\/([^/]+)/);
  return m ? decodeURIComponent(m[1]) : undefined;
}
/** "2026-08-21 22:00:00.0" -> "2026-08-21". */
function dpart(s?: string): string {
  if (typeof s !== 'string') return '';
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function dateArg(v: unknown): string {
  if (typeof v !== 'string') return '';
  const m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}
function todayISO(): string {
  const d = new Date(Date.now() + 2 * 3600 * 1000); // approx Madrid (CEST)
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}
function numArg(v: unknown, dflt: number): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? n : dflt;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.trunc(n)));
}

export default { tools, callTool, meter: { credits: 1 } } satisfies McpToolExport;
