import 'dotenv/config';
import axios from 'axios';
import { Queue } from 'bullmq';
import { Redis } from 'ioredis';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const SUBTITLE_SEED_LIMIT = Number(process.env.SUBTITLE_SEED_LIMIT ?? 200);
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

if (!TMDB_API_KEY) {
  console.error('TMDB_API_KEY missing in .env');
  process.exit(1);
}

const connection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
const queue = new Queue('subtitle-fetch', { connection });

async function fetchPage(page: number) {
  const res = await axios.get('https://api.themoviedb.org/3/movie/popular', {
    params: { api_key: TMDB_API_KEY, page },
  });
  return res.data.results as { id: number; title: string }[];
}

async function main() {
  console.log(`Seeding up to ${SUBTITLE_SEED_LIMIT} movies...`);
  let enqueued = 0;
  let page = 1;

  while (enqueued < SUBTITLE_SEED_LIMIT) {
    const results = await fetchPage(page);
    if (results.length === 0) break;

    for (const movie of results) {
      if (enqueued >= SUBTITLE_SEED_LIMIT) break;
      await queue.add('fetch', { tmdbId: movie.id, languages: ['es', 'en'] });
      enqueued++;
      if (enqueued % 20 === 0) {
        console.log(`Progress: ${enqueued}/${SUBTITLE_SEED_LIMIT}`);
      }
    }
    page++;
  }

  console.log(`Done. Enqueued ${enqueued} movies.`);
  await queue.close();
  await connection.quit();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
