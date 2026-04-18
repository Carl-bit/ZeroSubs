import 'dotenv/config';
import { Queue, Worker, type Job } from 'bullmq';
import { prisma } from '../db/prisma.js';
import { redis } from '../db/redis.js';
import { PodnapisiProvider } from '../services/subtitle/providers/PodnapisiProvider.js';
import { SubDLProvider } from '../services/subtitle/providers/SubDLProvider.js';
import { OpenSubtitlesProvider } from '../services/subtitle/providers/OpenSubtitlesProvider.js';
import type { SubtitleProvider } from '../services/subtitle/providers/types.js';

interface SubtitleFetchJob {
  tmdbId: number;
  languages: string[];
}

const providers: { name: string; provider: SubtitleProvider }[] = [
  { name: 'podnapisi', provider: new PodnapisiProvider() },
  { name: 'subdl', provider: new SubDLProvider() },
  { name: 'opensubtitles', provider: new OpenSubtitlesProvider(redis) },
];

const whisperQueue = new Queue('subtitle-whisper', { connection: redis });

async function processJob(job: Job<SubtitleFetchJob>): Promise<void> {
  const { tmdbId, languages } = job.data;

  for (const language of languages) {
    const existing = await prisma.subtitleCache.findUnique({
      where: { tmdbId_language: { tmdbId, language } },
    });
    if (existing) {
      console.log(
        `[subtitle-worker] skip tmdbId=${tmdbId} lang=${language} (cached from ${existing.source})`,
      );
      continue;
    }

    let saved = false;
    for (const { name, provider } of providers) {
      try {
        const result = await provider.search(tmdbId, language);
        if (!result) {
          console.log(
            `[subtitle-worker] miss tmdbId=${tmdbId} lang=${language} provider=${name}`,
          );
          continue;
        }

        await prisma.subtitleCache.upsert({
          where: { tmdbId_language: { tmdbId, language } },
          create: {
            tmdbId,
            language,
            content: result.content,
            source: result.source,
            score: result.score,
          },
          update: {
            content: result.content,
            source: result.source,
            score: result.score,
          },
        });
        console.log(
          `[subtitle-worker] hit tmdbId=${tmdbId} lang=${language} source=${result.source} score=${result.score}`,
        );
        saved = true;
        break;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(
          `[subtitle-worker] error tmdbId=${tmdbId} lang=${language} provider=${name}: ${msg}`,
        );
      }
    }

    if (!saved) {
      await whisperQueue.add('transcribe', { tmdbId, language });
      console.log(
        `[subtitle-worker] fallback -> whisper queue tmdbId=${tmdbId} lang=${language}`,
      );
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
