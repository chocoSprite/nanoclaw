#!/usr/bin/env npx tsx
/**
 * RSS Digest — 지정 피드에서 최근 24시간 글을 수집해 포맷팅
 * Usage: npx tsx scripts/rss-digest.ts [--hours 24] [--out-dir data/rss]
 */
import fs from 'fs';
import path from 'path';
import RssParser from 'rss-parser';

const FEEDS = [
  { name: 'Geek News', url: 'https://news.hada.io/rss/news' },
  { name: 'Google AI', url: 'https://blog.google/innovation-and-ai/technology/ai/rss/' },
  { name: 'OpenAI', url: 'https://openai.com/blog/rss.xml' },
  // Anthropic: RSS 미제공, 추후 X API (@claudeai)로 대체
];

interface FeedItem {
  source: string;
  title: string;
  link: string;
  date: Date;
  summary?: string;
}

async function fetchFeed(
  parser: RssParser,
  feed: { name: string; url: string },
  since: Date,
): Promise<FeedItem[]> {
  try {
    const result = await parser.parseURL(feed.url);
    return (result.items ?? [])
      .filter((item) => {
        const dateStr = item.pubDate ?? item.isoDate;
        const pub = dateStr ? new Date(dateStr) : null;
        return pub && pub >= since;
      })
      .map((item) => {
        const dateStr = (item.pubDate ?? item.isoDate)!;
        return {
          source: feed.name,
          title: item.title ?? '(제목 없음)',
          link: item.link ?? '',
          date: new Date(dateStr),
          summary: item.contentSnippet?.slice(0, 200),
        };
      });
  } catch (err) {
    console.error(`[${feed.name}] fetch failed:`, (err as Error).message);
    return [];
  }
}

function formatDigest(items: FeedItem[]): string {
  if (items.length === 0) return '새 글이 없습니다.';

  const grouped = new Map<string, FeedItem[]>();
  for (const item of items) {
    const list = grouped.get(item.source) ?? [];
    list.push(item);
    grouped.set(item.source, list);
  }

  const sections: string[] = [];
  for (const [source, sourceItems] of grouped) {
    const lines = sourceItems
      .sort((a, b) => b.date.getTime() - a.date.getTime())
      .map((item) => {
        const summary = item.summary ? `\n   ${item.summary}` : '';
        return `• <${item.link}|${item.title}>${summary}`;
      });
    sections.push(`*${source}* (${lines.length})\n${lines.join('\n')}`);
  }

  return sections.join('\n\n');
}

async function main() {
  const args = process.argv.slice(2);
  const hoursIdx = args.indexOf('--hours');
  const hours = hoursIdx >= 0 ? parseInt(args[hoursIdx + 1], 10) : 24;
  const outDirIdx = args.indexOf('--out-dir');
  const outDir = outDirIdx >= 0 ? args[outDirIdx + 1] : null;

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);
  const parser = new RssParser({ timeout: 10_000 });

  console.error(`Fetching RSS feeds (since ${since.toISOString()})...`);

  const results = await Promise.all(FEEDS.map((f) => fetchFeed(parser, f, since)));
  const allItems = results.flat().sort((a, b) => b.date.getTime() - a.date.getTime());

  const digest = formatDigest(allItems);
  console.error(`Found ${allItems.length} items`);

  if (outDir) {
    fs.mkdirSync(outDir, { recursive: true });
    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Seoul' }); // YYYY-MM-DD KST
    const filePath = path.join(outDir, `${today}.txt`);
    fs.writeFileSync(filePath, digest);
    const latestLink = path.join(outDir, 'latest.txt');
    try { fs.unlinkSync(latestLink); } catch {}
    fs.symlinkSync(path.basename(filePath), latestLink);
    console.error(`Saved to ${filePath} (latest.txt → ${path.basename(filePath)})`);
  } else {
    console.log(digest);
  }
}

main().catch(console.error);
