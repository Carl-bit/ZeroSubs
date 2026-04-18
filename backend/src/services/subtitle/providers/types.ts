export interface SubtitleResult {
  content: string;
  score: number;
  source: string;
}

export interface SubtitleProvider {
  search(tmdbId: number, language: string): Promise<SubtitleResult | null>;
}
