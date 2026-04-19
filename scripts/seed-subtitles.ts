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
const SUBTITLE_SEED_LIMIT = Number(process.env.SUBTITLE_SEED_LIMIT ?? 200);
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

type Movie = { id: number; title: string };

async function fetchPage(page: number): Promise<Movie[]> {
  const res = await axios.get('https://api.themoviedb.org/3/movie/popular', {
    params: { api_key: TMDB_API_KEY, page, language: 'en-US' },
  });
  return res.data.results as Movie[];
}

async function coveredTmdbIds(ids: number[], langs: string[]): Promise<Set<number>> {
  if (!ids.length) return new Set();
  const { rows } = await pg.query<{ tmdbid: number; language: string }>(
    'SELECT "tmdbId" AS tmdbid, language FROM "SubtitleCache" WHERE "tmdbId" = ANY($1) AND language = ANY($2)',
    [ids, langs],
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
    `Sembrando hasta ${SUBTITLE_SEED_LIMIT} peliculas (idiomas: ${LANGS.join(', ')})...`,
  );

  let processed = 0;
  let enqueued = 0;
  let alreadyInDb = 0;
  let duplicateJobs = 0;
  let page = 1;

  while (processed < SUBTITLE_SEED_LIMIT) {
    let results: Movie[];
    try {
      results = await fetchPage(page);
    } catch (err) {
      console.error(`TMDB page ${page} fallo: ${(err as Error).message}`);
      break;
    }
    if (!results.length) break;

    const remaining = SUBTITLE_SEED_LIMIT - processed;
    const slice = results.slice(0, remaining);
    const ids = slice.map((m) => m.id);

    const covered = pgOk ? await coveredTmdbIds(ids, LANGS) : new Set<number>();

    for (const movie of slice) {
      processed++;
      if (covered.has(movie.id)) {
        alreadyInDb++;
        continue;
      }
      const jobId = `tmdb-${movie.id}`;
      const existing = await queue.getJob(jobId);
      if (existing) {
        duplicateJobs++;
        continue;
      }
      await queue.add(
        'fetch',
        { tmdbId: movie.id, languages: LANGS },
        { jobId, removeOnComplete: true, removeOnFail: 100 },
      );
      enqueued++;
    }

    console.log(
      `Pagina ${page}: procesadas ${processed}/${SUBTITLE_SEED_LIMIT} | encoladas ${enqueued} | en DB ${alreadyInDb} | ya en cola ${duplicateJobs}`,
    );
    page++;
  }

  console.log('');
  console.log('=== Resumen seed ===');
  console.log(`Procesadas:      ${processed}`);
  console.log(`Encoladas nuevas:${enqueued}`);
  console.log(`Ya en DB:        ${alreadyInDb}`);
  console.log(`Ya en cola:      ${duplicateJobs}`);
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
