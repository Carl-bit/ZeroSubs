import 'dotenv/config';
import axios from 'axios';
import cron from 'node-cron';
import { Queue } from 'bullmq';
import { prisma } from '../db/prisma.js';
import { redis } from '../db/redis.js';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';
const LANGUAGES = ['es', 'en'];
const POPULAR_PAGES = 5;

interface TmdbMovie {
  id: number;
  title?: string;
}

interface TmdbResponse {
  results?: TmdbMovie[];
}

const fetchQueue = new Queue('subtitle-fetch', { connection: redis });

async function collectTmdbIds(): Promise<number[]> {
  if (!TMDB_API_KEY) {
    console.warn('[scheduler] TMDB_API_KEY not set, skipping run');
    return [];
  }

  const ids = new Set<number>();

  for (let page = 1; page <= POPULAR_PAGES; page++) {
    const res = await axios.get<TmdbResponse>(`${TMDB_BASE}/movie/popular`, {
      params: { api_key: TMDB_API_KEY, page },
      timeout: 15000,
    });
    for (const m of res.data.results ?? []) ids.add(m.id);
  }

  const trending = await axios.get<TmdbResponse>(`${TMDB_BASE}/trending/movie/week`, {
    params: { api_key: TMDB_API_KEY },
    timeout: 15000,
  });
  for (const m of trending.data.results ?? []) ids.add(m.id);

  return [...ids];
}

async function enqueueMissing(): Promise<void> {
  const started = Date.now();
  const ids = await collectTmdbIds();
  console.log(`[scheduler] ${ids.length} unique tmdbIds from popular+trending`);

  let enqueued = 0;
  for (const tmdbId of ids) {
    const existing = await prisma.subtitleCache.findMany({
      where: {
        tmdbId,
        mediaType: 'movie',
        season: 0,
        episode: 0,
        language: { in: LANGUAGES },
      },
      select: { language: true },
    });
    const have = new Set(existing.map((e) => e.language));
    const missing = LANGUAGES.filter((l) => !have.has(l));
    if (!missing.length) continue;

    await fetchQueue.add(
      'fetch',
      { tmdbId, mediaType: 'movie', languages: missing },
      { jobId: `tmdb-movie-${tmdbId}`, removeOnComplete: true, removeOnFail: 100 },
    );
    enqueued++;
  }

  const elapsed = ((Date.now() - started) / 1000).toFixed(1);
  console.log(`[scheduler] enqueued ${enqueued} movies in ${elapsed}s`);
}

cron.schedule('0 2 * * *', () => {
  console.log('[scheduler] cron fired');
  enqueueMissing().catch((err) => {
    console.error('[scheduler] run failed:', err instanceof Error ? err.message : err);
  });
});

console.log('[scheduler] running, cron="0 2 * * *" (nightly 2am)');

const shutdown = async () => {
  console.log('[scheduler] shutting down');
  await fetchQueue.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
