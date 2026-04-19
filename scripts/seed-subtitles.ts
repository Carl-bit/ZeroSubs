import { config as loadEnv } from 'dotenv';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import axios from 'axios';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';
import { Client as PgClient } from 'pg';

// .env puede vivir en raiz, docker/ o backend/. Cargamos el primero que exista.
const envCandidates = [
  resolve(process.cwd(), '.env'),
  resolve(process.cwd(), 'docker/.env.example'),
  resolve(process.cwd(), 'backend/.env.example'),
];
const envLoaded = envCandidates.find((p) => existsSync(p));
if (envLoaded) {
  loadEnv({ path: envLoaded });
  console.log(`Env cargado desde: ${envLoaded}`);
} else {
  console.warn('No se encontro .env en raiz, docker/ ni backend/. Usando variables del entorno.');
}

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const MOVIE_LIMIT = Number(
  process.env.SUBTITLE_SEED_MOVIE_LIMIT ?? process.env.SUBTITLE_SEED_LIMIT ?? 500,
);
const TV_LIMIT = Number(process.env.SUBTITLE_SEED_TV_LIMIT ?? 200);
const LANGS = (process.env.SUBTITLE_SEED_LANGS ?? 'es,en')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean);

// Los hostnames del compose (postgres, redis) no resuelven desde el host, y el
// puerto expuesto al host puede diferir del interno (ver POSTGRES_HOST_PORT /
// REDIS_HOST_PORT en compose.yml). Reescribimos hostname + puerto si aplica.
function hostRewrite(url: string, dockerHost: string, hostPort: number | undefined): string {
  const re = new RegExp(`@${dockerHost}:(\\d+)`);
  return url.replace(re, (_, internalPort: string) => `@localhost:${hostPort ?? internalPort}`);
}
const PG_HOST_PORT = process.env.POSTGRES_HOST_PORT ? Number(process.env.POSTGRES_HOST_PORT) : 5433;
const REDIS_HOST_PORT = process.env.REDIS_HOST_PORT ? Number(process.env.REDIS_HOST_PORT) : 6380;

const REDIS_URL = hostRewrite(
  process.env.REDIS_URL ?? `redis://localhost:${REDIS_HOST_PORT}`,
  'redis',
  REDIS_HOST_PORT,
);
const DATABASE_URL = process.env.DATABASE_URL
  ? hostRewrite(process.env.DATABASE_URL, 'postgres', PG_HOST_PORT)
  : undefined;

if (!TMDB_API_KEY) {
  console.error('TMDB_API_KEY missing in .env');
  process.exit(1);
}
if (!DATABASE_URL) {
  console.error('DATABASE_URL missing in .env');
  process.exit(1);
}

const pg = new PgClient({ connectionString: DATABASE_URL });
const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('subtitle-fetch', { connection: redis });

type MediaType = 'movie' | 'tv';
type Item = { id: number; title: string };

async function fetchPage(kind: MediaType, page: number): Promise<Item[]> {
  const endpoint = kind === 'movie' ? '/movie/popular' : '/tv/popular';
  const res = await axios.get(`https://api.themoviedb.org/3${endpoint}`, {
    params: { api_key: TMDB_API_KEY, page, language: 'en-US' },
  });
  // TV usa `name`, movies usan `title`.
  return (res.data.results as any[]).map((r) => ({
    id: r.id,
    title: r.title ?? r.name ?? `(${kind} ${r.id})`,
  }));
}

// Cobertura DB: una pelicula/show esta cubierto si tiene fila para cada idioma
// pedido, a nivel show (season=0, episode=0) - que es lo que sembramos aca.
async function coveredIds(kind: MediaType, ids: number[], langs: string[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { rows } = await pg.query<{ tmdbid: number; language: string }>(
    `SELECT "tmdbId" AS tmdbid, language FROM "SubtitleCache"
     WHERE "tmdbId" = ANY($1) AND "mediaType" = $2 AND season = 0 AND episode = 0
     AND language = ANY($3)`,
    [ids, kind, langs],
  );
  const byId = new Map<number, Set<string>>();
  for (const r of rows) {
    if (!byId.has(r.tmdbid)) byId.set(r.tmdbid, new Set());
    byId.get(r.tmdbid)!.add(r.language);
  }
  const covered = new Set<number>();
  for (const [id, langSet] of byId) {
    if (langs.every((l) => langSet.has(l))) covered.add(id);
  }
  return covered;
}

interface RunCounters {
  processed: number;
  enqueued: number;
  alreadyInDb: number;
  duplicateJobs: number;
}

async function seed(kind: MediaType, limit: number, pgOk: boolean): Promise<RunCounters> {
  const counters: RunCounters = { processed: 0, enqueued: 0, alreadyInDb: 0, duplicateJobs: 0 };
  if (limit <= 0) return counters;
  console.log(`\n--- Sembrando ${limit} ${kind === 'movie' ? 'peliculas' : 'series'} populares ---`);

  let page = 1;
  while (counters.processed < limit) {
    let results: Item[];
    try {
      results = await fetchPage(kind, page);
    } catch (err) {
      console.error(`TMDB ${kind} page ${page} fallo: ${(err as Error).message}`);
      break;
    }
    if (!results.length) break;

    const remaining = limit - counters.processed;
    const slice = results.slice(0, remaining);
    const ids = slice.map((m) => m.id);

    const covered = pgOk ? await coveredIds(kind, ids, LANGS) : new Set<number>();

    for (const item of slice) {
      counters.processed++;
      if (covered.has(item.id)) {
        counters.alreadyInDb++;
        continue;
      }
      const jobId = `tmdb-${kind}-${item.id}`;
      const existing = await queue.getJob(jobId);
      if (existing) {
        counters.duplicateJobs++;
        continue;
      }
      await queue.add(
        'fetch',
        { tmdbId: item.id, mediaType: kind, languages: LANGS },
        { jobId, removeOnComplete: true, removeOnFail: 100 },
      );
      counters.enqueued++;
    }

    console.log(
      `${kind} pagina ${page}: procesadas ${counters.processed}/${limit} | encoladas ${counters.enqueued} | en DB ${counters.alreadyInDb} | ya en cola ${counters.duplicateJobs}`,
    );
    page++;
  }

  return counters;
}

async function main() {
  let pgOk = false;
  try {
    await pg.connect();
    pgOk = true;
  } catch (err) {
    console.warn(
      `DB inalcanzable (${(err as Error).message}). Continuo sin dedup por DB; el worker se encargara.`,
    );
  }

  console.log(
    `Sembrando peliculas (${MOVIE_LIMIT}) + series (${TV_LIMIT}) | idiomas: ${LANGS.join(', ')}`,
  );

  // Orden: peliculas primero, series despues (series son mas pesadas por temporadas/episodios).
  const movies = await seed('movie', MOVIE_LIMIT, pgOk);
  const tv = await seed('tv', TV_LIMIT, pgOk);

  console.log('');
  console.log('=== Resumen seed ===');
  const row = (label: string, c: RunCounters) =>
    `${label.padEnd(12)} proc=${c.processed} nuevas=${c.enqueued} enDB=${c.alreadyInDb} enCola=${c.duplicateJobs}`;
  console.log(row('Peliculas:', movies));
  console.log(row('Series:', tv));
  console.log(`Total encoladas: ${movies.enqueued + tv.enqueued}`);
  console.log('====================');

  await queue.close();
  await redis.quit();
  if (pgOk) await pg.end();
}

main().catch(async (err) => {
  console.error(err);
  try {
    await queue.close();
  } catch {}
  try {
    await redis.quit();
  } catch {}
  try {
    await pg.end();
  } catch {}
  process.exit(1);
});
