import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { stripTailLoops } from './transcribe.js';

describe('stripTailLoops', () => {
  let tmpDir: string;
  let txtPath: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'transcribe-test-'));
    txtPath = path.join(tmpDir, 'transcript.txt');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('no-op when no repetition loop exists', () => {
    const content = ['안녕하세요.', '네.', '감사합니다.', '네.'].join('\n');
    fs.writeFileSync(txtPath, content);

    const removed = stripTailLoops(txtPath);

    expect(removed).toBe(0);
    expect(fs.readFileSync(txtPath, 'utf8')).toBe(content);
  });

  it('no-op when repetition is below threshold', () => {
    const content = ['시작', ...Array(9).fill('네.'), '끝'].join('\n');
    fs.writeFileSync(txtPath, content);

    const removed = stripTailLoops(txtPath);

    expect(removed).toBe(0);
    expect(fs.readFileSync(txtPath, 'utf8')).toBe(content);
  });

  it('truncates at start of first qualifying loop and appends marker', () => {
    const goodLines = ['의미있는 내용.', '그 다음 문장.'];
    const loopLine = 'AOS는 아마 그 영역이';
    const content = [...goodLines, ...Array(303).fill(loopLine)].join('\n');
    fs.writeFileSync(txtPath, content);

    const removed = stripTailLoops(txtPath);

    expect(removed).toBe(303);
    const result = fs.readFileSync(txtPath, 'utf8').split('\n');
    expect(result.slice(0, 2)).toEqual(goodLines);
    expect(result[2]).toMatch(/303 repeated lines truncated/);
    expect(result).not.toContain(loopLine);
  });

  it('keeps scattered repeats even if total count is high', () => {
    // "네." appears 30 times total but never 10+ in a row
    const content: string[] = [];
    for (let i = 0; i < 30; i++) {
      content.push('문장 ' + i);
      content.push('네.');
    }
    fs.writeFileSync(txtPath, content.join('\n'));

    const removed = stripTailLoops(txtPath);

    expect(removed).toBe(0);
  });

  it('respects custom threshold', () => {
    const content = ['시작', ...Array(5).fill('반복.'), '끝'].join('\n');
    fs.writeFileSync(txtPath, content);

    const removed = stripTailLoops(txtPath, 5);

    expect(removed).toBe(6); // 5 repeats + "끝" after them
    const result = fs.readFileSync(txtPath, 'utf8').split('\n');
    expect(result[0]).toBe('시작');
    expect(result[1]).toMatch(/6 repeated lines truncated/);
  });

  it('truncates even when loop is mid-file (preserves only lead)', () => {
    const lead = ['앞부분 내용.', '두번째.'];
    const loop = Array(15).fill('루프.');
    const tail = ['뒷부분은 잘림.', '이것도.'];
    fs.writeFileSync(txtPath, [...lead, ...loop, ...tail].join('\n'));

    const removed = stripTailLoops(txtPath);

    expect(removed).toBe(17); // 15 loop + 2 tail lines
    const result = fs.readFileSync(txtPath, 'utf8').split('\n');
    expect(result.slice(0, 2)).toEqual(lead);
    expect(result[2]).toMatch(/17 repeated lines truncated/);
  });
});
