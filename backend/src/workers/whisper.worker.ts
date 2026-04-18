import 'dotenv/config';
import axios from 'axios';
import { Worker, type Job } from 'bullmq';
import { prisma } from '../db/prisma.js';
import { redis } from '../db/redis.js';

interface WhisperJob {
  tmdbId: number;
  language: string;
  videoPath?: string;
}

interface SubgenResponse {
  srt?: string;
  content?: string;
}

const SUBGEN_URL = process.env.SUBGEN_URL;

async function processJob(job: Job<WhisperJob>): Promise<void> {
  const { tmdbId, language, videoPath } = job.data;

  if (!SUBGEN_URL) {
    console.log(
      `[whisper-worker] skip tmdbId=${tmdbId} lang=${language}: SUBGEN_URL not configured`,
    );
    return;
  }

  if (!videoPath) {
    console.log(
      `[whisper-worker] skip tmdbId=${tmdbId} lang=${language}: no local video_path`,
    );
    return;
  }

  const res = await axios.post<SubgenResponse>(
    `${SUBGEN_URL}/transcribe`,
    { video_path: videoPath, tmdb_id: tmdbId, language },
    { timeout: 600000 },
  );

  const content = res.data?.srt ?? res.data?.content;
  if (!content) {
    console.warn(`[whisper-worker] subgen returned no SRT tmdbId=${tmdbId} lang=${language}`);
    return;
  }

  await prisma.subtitleCache.upsert({
    where: { tmdbId_language: { tmdbId, language } },
    create: { tmdbId, language, content, source: 'whisper', score: 0 },
    update: { content, source: 'whisper', score: 0 },
  });

  console.log(`[whisper-worker] saved tmdbId=${tmdbId} lang=${language} source=whisper`);
}

const worker = new Worker<WhisperJob>('subtitle-whisper', processJob, {
  connection: redis,
  concurrency: 1,
});

worker.on('ready', () => {
  console.log(
    `[whisper-worker] ready queue=subtitle-whisper SUBGEN_URL=${SUBGEN_URL ?? '(unset)'}`,
  );
});

worker.on('failed', (job, err) => {
  console.error(`[whisper-worker] job ${job?.id} failed: ${err.message}`);
});

const shutdown = async () => {
  console.log('[whisper-worker] shutting down');
  await worker.close();
  await redis.quit();
  await prisma.$disconnect();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
