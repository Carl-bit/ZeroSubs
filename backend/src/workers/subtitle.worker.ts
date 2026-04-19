import 'dotenv/config';
import { Queue, Worker, type Job } from 'bullmq';
import { prisma } from '../db/prisma.js';
import { redis } from '../db/redis.js';
import { SubDLProvider } from '../services/subtitle/providers/SubDLProvider.js';
import { OpenSubtitlesProvider } from '../services/subtitle/providers/OpenSubtitlesProvider.js';
import type { MediaType, SubtitleProvider } from '../services/subtitle/providers/types.js';

interface SubtitleFetchJob {
  tmdbId: number;
  languages: string[];
  mediaType?: MediaType; // default "movie" por compat con jobs viejos
  season?: number;
  episode?: number;
}

const providers: { name: string; provider: SubtitleProvider }[] = [
  { name: 'subdl', provider: new SubDLProvider() },
  { name: 'opensubtitles', provider: new OpenSubtitlesProvider(redis) },
];

const whisperQueue = new Queue('subtitle-whisper', { connection: redis });

async function processJob(job: Job<SubtitleFetchJob>): Promise<void> {
  const { tmdbId, languages } = job.data;
  const mediaType: MediaType = job.data.mediaType ?? 'movie';
  const season = job.data.season ?? 0;
  const episode = job.data.episode ?? 0;
  const tag = `tmdbId=${tmdbId} type=${mediaType}${mediaType === 'tv' ? ` s${season}e${episode}` : ''}`;

  for (const language of languages) {
    const existing = await prisma.subtitleCache.findUnique({
      where: {
        tmdbId_mediaType_season_episode_language: {
          tmdbId,
          mediaType,
          season,
          episode,
          language,
        },
      },
    });
    if (existing) {
      console.log(`[subtitle-worker] skip ${tag} lang=${language} (cached from ${existing.source})`);
      continue;
    }

    let saved = false;
    for (const { name, provider } of providers) {
      try {
        const result = await provider.search({
          tmdbId,
          language,
          mediaType,
          season: mediaType === 'tv' ? season : undefined,
          episode: mediaType === 'tv' ? episode : undefined,
        });
        if (!result) {
          console.log(`[subtitle-worker] miss ${tag} lang=${language} provider=${name}`);
          continue;
        }

        const content = result.content.replace(/\u0000/g, '');

        await prisma.subtitleCache.upsert({
          where: {
            tmdbId_mediaType_season_episode_language: {
              tmdbId,
              mediaType,
              season,
              episode,
              language,
            },
          },
          create: {
            tmdbId,
            mediaType,
            season,
            episode,
            language,
            content,
            source: result.source,
            score: result.score,
          },
          update: {
            content,
            source: result.source,
            score: result.score,
          },
        });
        console.log(
          `[subtitle-worker] hit ${tag} lang=${language} source=${result.source} score=${result.score}`,
        );
        saved = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[subtitle-worker] error ${tag} lang=${language} provider=${name}: ${msg}`);
      }
    }

    if (!saved) {
      await whisperQueue.add('transcribe', { tmdbId, mediaType, season, episode, language });
      console.log(`[subtitle-worker] fallback -> whisper queue ${tag} lang=${language}`);
    }
  }
}

const worker = new Worker<SubtitleFetchJob>('subtitle-fetch', processJob, {
  connection: redis,
  concurrency: 3,
});

worker.on('ready', () => {
  console.log('[subtitle-worker] ready queue=subtitle-fetch concurrency=3');
});

worker.on('failed', (job, err) => {
  console.error(`[subtitle-worker] job ${job?.id} failed: ${err.message}`);
});

const shutdown = async () => {
  console.log('[subtitle-worker] shutting down');
  await worker.close();
  await whisperQueue.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
