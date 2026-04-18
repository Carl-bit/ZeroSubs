import axios, { type AxiosInstance } from 'axios';
import type { Redis } from 'ioredis';
import type { SubtitleProvider, SubtitleResult } from './types.js';

const DAILY_LIMIT = 20;
const COUNTER_KEY = 'os_daily_count';
const TTL_SECONDS = 86400;

interface OSFile {
  file_id: number;
}

interface OSAttributes {
  download_count?: number;
  files?: OSFile[];
}

interface OSResult {
  attributes?: OSAttributes;
}

interface OSSearchResponse {
  data?: OSResult[];
}

interface OSLoginResponse {
  token: string;
}

interface OSDownloadResponse {
  link?: string;
}

export class OpenSubtitlesProvider implements SubtitleProvider {
  private readonly client: AxiosInstance;
  private token: string | null = null;

  constructor(
    private readonly redis: Redis,
    private readonly apiKey: string = process.env.OPENSUBTITLES_API_KEY ?? '',
    private readonly username: string = process.env.OPENSUBTITLES_USERNAME ?? '',
    private readonly password: string = process.env.OPENSUBTITLES_PASSWORD ?? '',
  ) {
    this.client = axios.create({
      baseURL: 'https://api.opensubtitles.com/api/v1',
      headers: {
        'Api-Key': this.apiKey,
        'User-Agent': 'ZeroSubs v0.1',
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 15000,
    });
  }

  async search(tmdbId: number, language: string): Promise<SubtitleResult | null> {
    const searchRes = await this.client.get<OSSearchResponse>('/subtitles', {
      params: { tmdb_id: tmdbId, languages: language },
    });
    const data = searchRes.data?.data ?? [];
    if (!data.length) return null;

    const best = data.reduce((a, b) =>
      (b.attributes?.download_count ?? 0) > (a.attributes?.download_count ?? 0) ? b : a,
    );
    const fileId = best.attributes?.files?.[0]?.file_id;
    if (!fileId) return null;

    if (!(await this.reserveDownloadSlot())) return null;

    const token = await this.login();
    const dlRes = await this.client.post<OSDownloadResponse>(
      '/download',
      { file_id: fileId },
      { headers: { Authorization: `Bearer ${token}` } },
    );

    const link = dlRes.data?.link;
    if (!link) return null;

    const srtRes = await axios.get<string>(link, { timeout: 20000, responseType: 'text' });

    return {
      content: srtRes.data,
      score: best.attributes?.download_count ?? 0,
      source: 'opensubtitles',
    };
  }

  private async reserveDownloadSlot(): Promise<boolean> {
    const count = await this.redis.incr(COUNTER_KEY);
    if (count === 1) await this.redis.expire(COUNTER_KEY, TTL_SECONDS);
    if (count > DAILY_LIMIT) {
      await this.redis.decr(COUNTER_KEY);
      return false;
    }
    return true;
  }

  private async login(): Promise<string> {
    if (this.token) return this.token;
    const res = await this.client.post<OSLoginResponse>('/login', {
      username: this.username,
      password: this.password,
    });
    this.token = res.data.token;
    return this.token;
  }
}
